const express = require('express');
const { v2: webdavServer } = require('webdav-server');
const { createClient } = require('webdav');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const mime = require('mime-types');
const multer = require('multer');
let sharp;
try {
    sharp = require('sharp');
} catch (e) {
    console.warn('[WARN] Sharp module not found or failed to load. Image processing disabled.', e.message);
}
const { encrypt, decrypt } = require('./utils/crypto');

const app = express();
const PORT = process.env.PORT || 8000;
const STORAGE_DIR = os.homedir(); // Default to User Home directory
const APP_DATA_DIR = process.env.USER_DATA_PATH || path.join(os.homedir(), '.webdav-client');
const CONFIG_FILE = path.join(APP_DATA_DIR, 'drives.json');
// ...
// ...

// GET /api/preview (Image Preview & Conversion)
app.get('/api/preview', async (req, res) => {
    try {
        const { path: reqPath, drive: driveId = 'local' } = req.query;
        if (!reqPath) return res.status(400).send('Path required');
        const config = await getDriveConfig(driveId);
        
        const fileName = path.basename(reqPath);
        const isHeic = /\.(heic|heif)$/i.test(fileName);
        
        // Setup Source Stream
        let inputStream;
        if (config.type === 'local') {
             const absPath = resolveSafePath(reqPath);
             // Verify existence before stream (optional but good) to avoid stream error immediately
             if (!fs.existsSync(absPath)) return res.status(404).send('File not found');
             inputStream = fs.createReadStream(absPath);
        } else {
             const client = getWebDAVClient(config);
             inputStream = client.createReadStream(reqPath);
        }

        // Global Stream Error Handler (Vital to prevent crashes)
        inputStream.on('error', (err) => {
            console.error('[Preview Stream Error]', err);
            if (!res.headersSent) res.status(500).end();
        });

        if (isHeic && sharp) {
            res.setHeader('Content-Type', 'image/jpeg');
            const transform = sharp().toFormat('jpeg', { quality: 80 });
            
            inputStream
                .on('error', err => {
                     console.error('[Preview Stream Error]', err);
                     if (!res.headersSent) res.status(502).end();
                })
                .pipe(transform)
                .on('error', err => {
                     console.error('[Preview Convert Error]', err);
                     // If conversion fails, maybe stream original? 
                     // But header is already jpeg.
                     if (!res.headersSent) res.status(500).end();
                })
                .pipe(res);
        } else {
            // Passthrough for standard images (or could resize here too)
            const mimeType = mime.lookup(fileName) || 'application/octet-stream';
            res.setHeader('Content-Type', mimeType);
            inputStream.pipe(res);
        }

    } catch (err) {
        console.error('[Preview API Error]', err);
        if (!res.headersSent) res.status(500).send(err.message);
    }
});


// Ensure storage directory exists
fs.ensureDirSync(STORAGE_DIR);
fs.ensureDirSync(APP_DATA_DIR);
if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeJsonSync(CONFIG_FILE, [{ id: 'local', name: 'Local Storage', type: 'local', path: './storage' }]);
}

app.use(cors());
app.use(express.json());

// --- Drive Helper: Get Client for Drive ---
const getDriveConfig = async (driveId) => {
    const drives = await fs.readJson(CONFIG_FILE);
    const drive = drives.find(d => d.id === driveId) || drives[0];
    // Decrypt password for internal use
    if (drive.password) {
        drive.password = decrypt(drive.password);
    }
    return drive;
};

const getWebDAVClient = (config) => {
    return createClient(config.url.trim(), {
        username: config.username,
        password: config.password, // Config already has decrypted password
        headers: {
            // Jianguoyun and some other WebDAV servers block unknown/empty User-Agents
            // Mimic a standard client or just be explicit
            'User-Agent': 'WebDavClient/1.0.0 (Electron)'
        }
    });
};

// Helper: Normalize file info for frontend
const normalizeFile = (file, driveId) => {
    return {
        name: file.basename || path.basename(file.filename),
        path: file.filename, // Remote paths are already relative to its root
        isDirectory: file.type === 'directory',
        size: file.size || 0,
        mtime: file.lastmod,
        type: file.type === 'directory' ? 'folder' : mime.lookup(file.filename) || 'application/octet-stream'
    };
};

// --- Drives API ---
app.get('/api/drives', async (req, res) => {
    let drives = [];
    try {
        drives = await fs.readJson(CONFIG_FILE);
    } catch (e) {
        drives = [{ id: 'local', name: 'Local Storage', type: 'local', path: './storage' }];
    }

    try {
        const drivesWithQuota = await Promise.all(drives.map(async (drive) => {
            // Decrypt for quota check (internal connection)
            const internalDrive = { ...drive };
            if (internalDrive.password) {
                internalDrive.password = decrypt(internalDrive.password);
            }

            // Prepare public drive object (NO PASSWORD)
            const publicDrive = { ...drive };
            delete publicDrive.password; // Remove password from response

            try {
                const withTimeout = (promise, ms) => Promise.race([
                    promise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
                ]);

                if (internalDrive.type === 'webdav') {
                    const client = getWebDAVClient(internalDrive);
                    const quota = await withTimeout(client.getQuota(), 2000); 
                    if (quota && quota.used !== undefined && quota.available !== undefined) {
                        const used = parseInt(quota.used, 10) || 0;
                        const available = parseInt(quota.available, 10) || 0;
                        return { ...publicDrive, quota: { used, total: used + available } };
                    }
                } else if (internalDrive.type === 'local') {
                    const stats = await fs.statfs(STORAGE_DIR);
                    const total = stats.blocks * stats.bsize;
                    const available = stats.bfree * stats.bsize;
                    return { ...publicDrive, quota: { used: total - available, total } };
                }
            } catch (e) {}
            return { ...publicDrive, quota: null };
        }));
        
        // Log without sensitive data
        console.log('[DEBUG] Drives Quota:', JSON.stringify(drivesWithQuota.map(d => ({id: d.id, quota: d.quota})), null, 2));
        res.json(drivesWithQuota);
    } catch (err) {
        // Fallback: strip passwords even on error
        const safeDrives = drives.map(d => {
            const safe = { ...d };
            delete safe.password;
            return safe;
        });
        res.json(safeDrives);
    }
});

const crypto = require('crypto');

app.post('/api/drives', async (req, res) => {
    try {
        const newDrive = req.body;
        // Don't log password!
        const logSafeDrive = { ...newDrive, password: '***' };
        console.log('[DEBUG] POST /api/drives payload:', logSafeDrive);
        
        let drives = [];
        try {
            drives = await fs.readJson(CONFIG_FILE);
            if (!Array.isArray(drives)) throw new Error('Not an array');
        } catch (e) {
            drives = [{ id: 'local', name: 'Local Storage', type: 'local', path: './storage' }];
        }

        // Check for duplicates (URL + Username)
        if (drives.some(d => d.url === newDrive.url && d.username === newDrive.username)) {
            console.warn('[WARN] Duplicate Drive:', newDrive.url);
            return res.status(409).json({ error: 'This drive account is already added' });
        }

        // Check for Duplicate Name
        if (drives.some(d => d.name === newDrive.name)) {
            return res.status(409).json({ error: 'Display Name is already taken' });
        }

        // Encrypt Password
        if (newDrive.password) {
            newDrive.password = encrypt(newDrive.password);
        }

        // Assign reliable ID
        newDrive.id = crypto.randomUUID();
        
        drives.push(newDrive);
        await fs.writeJson(CONFIG_FILE, drives, { spaces: 2 });
        console.log('[DEBUG] Write success. New count:', drives.length);
        
        // Return safe object (no password or masked)
        const safeResponse = { ...newDrive };
        delete safeResponse.password;
        res.json(safeResponse);
    } catch (err) {
        console.error('[ERROR] Add Drive Failed:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/drives/test', async (req, res) => {
    try {
        const config = req.body;
        // Config comes plain text from client request body
        const client = createClient(config.url, {
            username: config.username,
            password: config.password
        });
        await client.getDirectoryContents('/'); // Try to list root
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: 'Connection failed', details: err.message });
    }
});

app.delete('/api/drives/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (id === 'local') return res.status(400).json({ error: 'Cannot delete local drive' });

        const drives = await fs.readJson(CONFIG_FILE);
        const newDrives = drives.filter(d => d.id !== id);
        await fs.writeJson(CONFIG_FILE, newDrives, { spaces: 2 });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/drives/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Name required' });

        const drives = await fs.readJson(CONFIG_FILE);
        const driveIndex = drives.findIndex(d => d.id === id);
        if (driveIndex === -1) return res.status(404).json({ error: 'Drive not found' });

        // Check duplicate name (excluding self)
        if (drives.some(d => d.name === name && d.id !== id)) {
            return res.status(409).json({ error: 'Display Name is already taken' });
        }

        drives[driveIndex].name = name;
        // Password remains untouched (encrypted)
        
        console.log('[DEBUG] Renaming drive:', id, 'to', name, '. Total drives:', drives.length);
        await fs.writeJson(CONFIG_FILE, drives, { spaces: 2 });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Core File APIs (Proxy Logic) ---

// Helper: Safe path resolution
const resolveSafePath = (userPath) => {
    // Remove leading slashes to ensure it's relative
    const safeSuffix = path.normalize(userPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    const absolutePath = path.resolve(STORAGE_DIR, safeSuffix);
    if (!absolutePath.startsWith(STORAGE_DIR)) {
        throw new Error('Access denied: Path traversal detected');
    }
    return absolutePath;
};

// GET /api/files?path=/&drive=local
app.get('/api/files', async (req, res) => {
    try {
        const { path: reqPath = '/', drive: driveId = 'local' } = req.query;
        console.log(`[DEBUG] GET /api/files path="${reqPath}" drive="${driveId}"`);

        const config = await getDriveConfig(driveId);
        if (!config) return res.status(404).json({ error: 'Drive config not found' });

        if (config.type === 'local') {
            const absolutePath = resolveSafePath(reqPath);
            const safePath = path.relative(STORAGE_DIR, absolutePath); // Return relative path
            
            const allFiles = await fs.readdir(absolutePath);
            // Filter out hidden files
            const files = allFiles.filter(f => !f.startsWith('.'));

            const fileList = await Promise.all(files.map(async file => {
                const fullPath = path.join(absolutePath, file);
                const relPath = path.join('/', safePath, file); // Ensure absolute Web path
                const stats = await fs.stat(fullPath);
                
                let itemCount = undefined;
                if (stats.isDirectory()) {
                    try {
                        const children = await fs.readdir(fullPath);
                        itemCount = children.filter(c => !c.startsWith('.')).length;
                    } catch (e) { itemCount = 0; }
                }

                return {
                    name: file,
                    path: relPath, // Return consistent path format
                    isDirectory: stats.isDirectory(),
                    size: stats.size,
                    mtime: stats.mtime,
                    itemCount: itemCount,
                    type: stats.isDirectory() ? 'folder' : mime.lookup(fullPath) || 'application/octet-stream'
                };
            }));
            res.json({ path: safePath, files: fileList });
        } else {
            // WebDAV Proxy
            const client = getWebDAVClient(config);
            try {
                const items = await client.getDirectoryContents(reqPath);
                res.json({
                    path: reqPath,
                    files: items.map(item => normalizeFile(item, driveId))
                });
            } catch (proxyErr) {
                console.error('WebDAV Proxy Error:', proxyErr.message);
                // Return 502 Bad Gateway to indicate upstream failure
                res.status(502).json({ error: `WebDAV Error: ${proxyErr.message}` });
            }
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/search
app.get('/api/search', async (req, res) => {
    try {
        const { query, drive: driveId = 'local', path: searchPath = '/' } = req.query;
        if (!query) return res.json([]);

        console.log(`[DEBUG] GET /api/search query="${query}" drive="${driveId}"`);

        const config = await getDriveConfig(driveId);
        if (!config) return res.status(404).json({ error: 'Drive config not found' });

        if (config.type === 'local') {
            const absoluteRoot = resolveSafePath(searchPath);
            const results = [];
            
            // Helper for recursive search
            const walk = async (dir) => {
                if (results.length >= 100) return; // Limit results
                try {
                    const files = await fs.readdir(dir, { withFileTypes: true });
                    for (const file of files) {
                        if (file.name.startsWith('.')) continue;
                        if (results.length >= 100) break;
                        
                        const fullPath = path.join(dir, file.name);
                        
                        if (file.name.toLowerCase().includes(query.toLowerCase())) {
                            const relPath = path.relative(STORAGE_DIR, fullPath);
                            results.push({
                                name: file.name,
                                path: '/' + relPath.split(path.sep).join('/'),
                                isDirectory: file.isDirectory(),
                                size: 0, // Skip stat for speed
                                mtime: 0,
                                type: file.isDirectory() ? 'folder' : mime.lookup(file.name) || 'application/octet-stream'
                            });
                        }
                        
                        if (file.isDirectory()) {
                            await walk(fullPath);
                        }
                    }
                } catch (e) {
                    // Ignore access errors
                }
            };

            await walk(absoluteRoot);
            res.json(results);
        } else {
            // WebDAV Search (Naive: Filter current directory only, or try deep)
            // Recursive WebDAV is risky. For now, we search CURRENT directory only via proxy
            // To be safe and consistent with previous "current view" behavior but server-side.
            // OR: We try to get "deep" but with caution.
            
            // Current Decision: Only search current folder for WebDAV to prevent timeouts.
            // Users can navigate and search.
            const client = getWebDAVClient(config);
            const items = await client.getDirectoryContents(searchPath);
            const results = items
                .filter(item => item.basename.toLowerCase().includes(query.toLowerCase()))
                .map(item => normalizeFile(item, driveId));
            res.json(results);
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/raw (Serve file)
app.get('/api/raw', async (req, res) => {
    try {
        const { path: reqPath, drive: driveId = 'local' } = req.query;
        if (!reqPath) return res.status(400).send('Path required');
        const config = await getDriveConfig(driveId);

        if (config.type === 'local') {
            res.sendFile(resolveSafePath(reqPath));
        } else {
            const client = getWebDAVClient(config);
            
            const options = {
                method: 'GET',
                headers: {},
                responseType: 'stream',
                // Important: validateStatus to allow 2xx and others like 416 to be handled manually if needed
                // But webdav lib might wrap axios. Let's try basic usage.
            };

            // Forward Range Header
            if (req.headers.range) {
                options.headers['Range'] = req.headers.range;
            }

            try {
                // Use customRequest to bypass potential createReadStream limitations
                // and get full access to upstream response headers/status
                const response = await client.customRequest(reqPath, options);
                
                // Helper to get header (Handles Fetch Headers object vs Axios plain object)
                const getHeader = (key) => {
                    if (response.headers && typeof response.headers.get === 'function') {
                        return response.headers.get(key);
                    }
                    // Axios headers are usually lowercased, but let's be safe
                    return response.headers ? (response.headers[key] || response.headers[key.toLowerCase()]) : null;
                };

                // Forward Status (200, 206, etc.)
                res.status(response.status);
                
                // Forward specific headers
                const forwardHeaders = [
                    'content-type',
                    'content-length',
                    'content-range',
                    'accept-ranges',
                    'last-modified',
                    'etag',
                    'cache-control'
                ];
                
                forwardHeaders.forEach(key => {
                    const val = getHeader(key);
                    if (val) {
                        // If we are about to pipe a stream that might be decompressed or modified, 
                        // sometimes it's safer to let the server calculate content-length or use chunked encoding.
                        // But for PDF/Video, Safari REQUIRES content-length and content-range to match exactly.
                        res.setHeader(key, val);
                    }
                });

                // Ensure Accept-Ranges is advertised if it's a 206 or upstream says so
                if (response.status === 206 && !res.getHeader('accept-ranges')) {
                    res.setHeader('Accept-Ranges', 'bytes');
                }

                // Get Stream: Prioritize body (Fetch) to avoid DeprecationWarning on data (node-fetch)
                let stream = response.body || response.data;
                if (!stream) throw new Error('No response stream available');

                // Fallback Content-Type if upstream didn't send one
                if (!getHeader('content-type')) {
                    const fileName = path.basename(reqPath);
                    const mimeType = mime.lookup(fileName) || 'application/octet-stream';
                    res.setHeader('Content-Type', mimeType);
                }

                if (typeof stream.pipe !== 'function') {
                    // Handle Web Stream (Node 18+ native fetch) if necessary
                    try {
                        const { Readable } = require('stream');
                        if (Readable.fromWeb) {
                            stream = Readable.fromWeb(stream);
                        }
                    } catch (e) {
                        console.warn('[Raw] Failed to convert WebStream:', e);
                    }
                }

                if (typeof stream.pipe === 'function') {
                    stream.pipe(res);
                    stream.on('error', (streamErr) => {
                        console.error('Upstream Stream Error:', streamErr);
                    });
                } else {
                    // Fallback for non-stream data?
                    console.error('[Raw] Response is not a stream');
                    res.status(500).send('Upstream response is not a stream');
                }

            } catch (err) {
                // Handle Upstream Errors (404, 416, 401, etc.)
                if (err.response) {
                    res.status(err.response.status);
                    // Forward headers for error response too (like Content-Range for 416)
                    const errHeaders = ['content-range', 'content-length', 'content-type'];
                    errHeaders.forEach(key => {
                        if (err.response.headers[key]) res.setHeader(key, err.response.headers[key]);
                    });
                    
                    if (err.response.data && typeof err.response.data.pipe === 'function') {
                        err.response.data.pipe(res);
                    } else {
                        res.send(err.message);
                    }
                } else {
                    console.error('[WebDAV Raw Error]', err.message);
                    res.status(502).send('Proxy Error: ' + err.message);
                }
            }
        }
    } catch (err) {
        console.error('[Raw API Error]', err);
        if (!res.headersSent) res.status(500).send(err.message);
    }
});

// POST /api/mkdir
app.post('/api/mkdir', async (req, res) => {
    try {
        const { path: reqPath, drive: driveId = 'local' } = req.body;
        console.log(`[DEBUG] POST /api/mkdir path="${reqPath}" drive="${driveId}"`);
        const config = await getDriveConfig(driveId);

        if (config.type === 'local') {
            const absPath = resolveSafePath(reqPath);
            console.log(`[Mkdir] Creating local directory: ${absPath}`);
            await fs.ensureDir(absPath);
        } else {
            const client = getWebDAVClient(config);
            await client.createDirectory(reqPath);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Mkdir Error]', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/delete
app.post('/api/delete', async (req, res) => {
    try {
        const { items, drive: driveId = 'local' } = req.body;
        console.log(`[DEBUG] POST /api/delete count=${items?.length} drive="${driveId}"`);
        const config = await getDriveConfig(driveId);

        if (config.type === 'local') {
            await Promise.all(items.map(async itemPath => {
                const absPath = resolveSafePath(itemPath);
                console.log(`[Delete] Local item: ${absPath}`);
                await fs.remove(absPath);
            }));
        } else {
            const client = getWebDAVClient(config);
            await Promise.all(items.map(item => client.deleteFile(item.replace(/^\/+/, ''))));
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Delete Error]', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/move
app.post('/api/move', async (req, res) => {
    try {
        const { items, destination, drive: driveId = 'local' } = req.body;
        const config = await getDriveConfig(driveId);

        if (config.type === 'local') {
            await Promise.all(items.map(async itemPath => {
                const absItem = resolveSafePath(itemPath);
                // Destination is a FOLDER in move API
                const absDestDir = resolveSafePath(destination);
                const absNewPath = path.join(absDestDir, path.basename(absItem));
                
                console.log(`[Move] ${absItem} -> ${absNewPath}`);
                if (absItem !== absNewPath) await fs.move(absItem, absNewPath, { overwrite: true });
            }));
        } else {
            const client = getWebDAVClient(config);
            await Promise.all(items.map(item => {
                const cleanDest = destination.replace(/^\/+/, '');
                const destPath = path.posix.join(cleanDest, path.basename(item));
                return client.moveFile(item.replace(/^\/+/, ''), destPath);
            }));
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Move Error]', err);
        res.status(500).json({ error: err.message });
    }
});

const { pipeline } = require('stream/promises');

// POST /api/transfer (Cross-drive copy/move)
app.post('/api/transfer', async (req, res) => {
    try {
        const { items, sourceDrive, destDrive, destPath, move } = req.body;
        if (!items || !sourceDrive || !destDrive) return res.status(400).json({ error: 'Missing parameters' });

        const srcConfig = await getDriveConfig(sourceDrive);
        const dstConfig = await getDriveConfig(destDrive);

        for (const itemPath of items) {
            const fileName = path.basename(itemPath);
            // Construct target path (WebDAV is posix, Local depends on OS but internal logic uses /)
            // We use path.posix.join for consistency in URL/Virtual paths
            const targetPath = path.posix.join(destPath, fileName);

            // 1. Get Read Stream
            let readStream;
            if (srcConfig.type === 'local') {
                const absPath = resolveSafePath(itemPath);
                if (!fs.existsSync(absPath)) continue; // Skip missing
                readStream = fs.createReadStream(absPath);
            } else {
                const client = getWebDAVClient(srcConfig);
                readStream = client.createReadStream(itemPath);
            }

            // Prevent crash on read error (e.g. file deleted during transfer)
            readStream.on('error', (err) => {
                console.error(`[Transfer Stream Error] ${itemPath}:`, err);
            });

            // 2. Write Stream
            if (dstConfig.type === 'local') {
                const absDestDir = resolveSafePath(destPath);
                await fs.ensureDir(absDestDir);
                const absDestFile = path.join(absDestDir, fileName);
                const writeStream = fs.createWriteStream(absDestFile);
                
                // Add error handling for writeStream
                writeStream.on('error', (err) => {
                    console.error(`[Transfer Write Error] ${absDestFile}:`, err);
                    readStream.destroy(); // Stop reading if write fails
                });

                await pipeline(readStream, writeStream);
            } else {
                const client = getWebDAVClient(dstConfig);
                // webdav lib putFileContents accepts stream
                await client.putFileContents(targetPath, readStream);
            }

            // 3. Delete Source if Move
            if (move) {
                if (srcConfig.type === 'local') {
                    await fs.remove(resolveSafePath(itemPath));
                } else {
                    const client = getWebDAVClient(srcConfig);
                    await client.deleteFile(itemPath);
                }
            }
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Transfer Error]', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/rename
app.post('/api/rename', async (req, res) => {
    try {
        const { oldPath, newName, path: currentPath, drive: driveId = 'local' } = req.body;
        console.log(`[DEBUG] POST /api/rename old="${oldPath}" new="${newName}" drive="${driveId}"`);
        if (!oldPath || !newName) return res.status(400).json({ error: 'Missing parameters' });

        const config = await getDriveConfig(driveId);

        if (config.type === 'local') {
            // Local Rename using resolveSafePath for consistency
            const absOld = resolveSafePath(oldPath);
            const absDir = path.dirname(absOld);
            const absNew = path.join(absDir, newName); // Same dir, new name

            console.log(`[Rename] ${absOld} -> ${absNew}`);
            await fs.rename(absOld, absNew);
        } else {
            // WebDAV Rename
            const client = getWebDAVClient(config);
            // Strip leading slashes
            const cleanOldPath = oldPath.replace(/^\/+/, '');
            
            const parentDir = path.dirname(cleanOldPath);
            const safeParentDir = parentDir.split(path.sep).join('/');
            const newPath = path.posix.join(safeParentDir, newName);
            
            await client.moveFile(cleanOldPath, newPath);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Rename Error]', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/prepare-drag (For Native Drag & Drop)
app.post('/api/prepare-drag', async (req, res) => {
    try {
        const { items, drive: driveId = 'local' } = req.body;
        console.log(`[Drag] Preparing ${items?.length} items from ${driveId}`);
        
        if (!items || items.length === 0) return res.json({ files: [] });

        const config = await getDriveConfig(driveId);
        const resolvedFiles = [];

        if (config.type === 'local') {
            // Return absolute local paths
            for (const itemPath of items) {
                const absPath = resolveSafePath(itemPath);
                if (fs.existsSync(absPath)) {
                    resolvedFiles.push(absPath);
                }
            }
        } else {
            // WebDAV: Download to Temp in Parallel
            const client = getWebDAVClient(config);
            const tempDir = path.join(os.tmpdir(), 'webdav-drag-cache');
            await fs.ensureDir(tempDir);

            // Parallelize downloads
            const downloadPromises = items.map(async (itemPath) => {
                try {
                    const fileName = path.basename(itemPath);
                    const tempFilePath = path.join(tempDir, fileName);
                    
                    console.log(`[Drag] Downloading ${itemPath} to ${tempFilePath}`);
                    const content = await client.getFileContents(itemPath, { format: 'binary' });
                    await fs.writeFile(tempFilePath, content);
                    return tempFilePath;
                } catch (e) {
                    console.error(`[Drag] Failed to download ${itemPath}:`, e.message);
                    return null;
                }
            });

            const results = await Promise.all(downloadPromises);
            resolvedFiles.push(...results.filter(p => p !== null));
        }

        res.json({ files: resolvedFiles });
    } catch (err) {
        console.error('[Drag Error]', err);
        res.status(500).json({ error: err.message });
    }
});

// Multer & Upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const { path: reqPath = '/', drive: driveId = 'local' } = req.query;
        console.log(`[Upload] Destination check: drive=${driveId}, path=${reqPath}`);
        
        try {
            if (driveId === 'local') {
                const absPath = resolveSafePath(reqPath);
                fs.ensureDirSync(absPath);
                cb(null, absPath);
            } else {
                const tempDir = os.tmpdir();
                cb(null, tempDir); 
            }
        } catch (e) {
            console.error('[Upload] Destination Error:', e);
            cb(e);
        }
    },
    filename: (req, file, cb) => {
        // Fix UTF-8 filenames
        const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, name);
    }
});

const upload = multer({ 
    storage,
    limits: { fileSize: 10 * 1024 * 1024 * 1024 } // 10GB limit example
});

app.post('/api/upload', upload.array('files'), async (req, res) => {
    const uploadedFiles = req.files || [];
    const { path: reqPath = '/', drive: driveId = 'local' } = req.query;
    console.log(`[Upload] Processing ${uploadedFiles.length} files. Drive: ${driveId}`);

    try {
        const config = await getDriveConfig(driveId);

        if (config.type !== 'local') {
            const client = getWebDAVClient(config);
            
            for (const file of uploadedFiles) {
                try {
                    console.log(`[Upload] Transferring to WebDAV: ${file.filename}`);
                    // Ensure remote path is absolute (starts with /)
                    // path.posix.join handles slash deduplication
                    const remotePath = path.posix.join('/', reqPath, file.filename);
                    
                    const readStream = fs.createReadStream(file.path);
                    readStream.on('error', (err) => console.error(`[Upload Stream Error] ${file.filename}:`, err));

                    await client.putFileContents(remotePath, readStream);
                    console.log(`[Upload] Success: ${remotePath}`);
                } catch (e) {
                    console.error(`[Upload] Failed to upload ${file.filename} to WebDAV:`, e);
                    throw e; // Stop processing to report error
                } finally {
                    // Always cleanup temp file
                    await fs.remove(file.path).catch(e => console.error('Failed to cleanup temp file:', e));
                }
            }
        } else {
             console.log('[Upload] Local files saved directly via Multer.');
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Upload API Error]', err);
        // Attempt cleanup on error for any remaining files
        if (uploadedFiles.length > 0 && driveId !== 'local') {
            for (const file of uploadedFiles) {
                await fs.remove(file.path).catch(() => {});
            }
        }
        res.status(500).json({ error: err.message });
    }
});

// --- WebDAV Server (For external mounting of LOCAL drive only) ---
const userManager = new webdavServer.SimpleUserManager();
const user = userManager.addUser('admin', 'admin', true);
const privilegeManager = new webdavServer.SimplePathPrivilegeManager();
privilegeManager.setRights(user, '/', ['all']);
const server = new webdavServer.WebDAVServer({
    httpAuthentication: new webdavServer.HTTPDigestAuthentication(userManager, 'Default Realm'),
    privilegeManager: privilegeManager
});
server.setFileSystem('/', new webdavServer.PhysicalFileSystem(STORAGE_DIR), (s) => {});
app.use(webdavServer.extensions.express('/webdav', server));

// Serve static files from React app (for production/electron)
const CLIENT_BUILD_PATH = path.join(__dirname, '../client/dist');
console.log(`[Server] Checking Client Build Path: ${CLIENT_BUILD_PATH}`);

if (fs.existsSync(CLIENT_BUILD_PATH)) {
    console.log('[Server] Client Build found. Serving static files.');
    app.use(express.static(CLIENT_BUILD_PATH));
    
    // Handle SPA routing: return index.html for any unknown non-API routes
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/webdav')) {
            return next();
        }
        res.sendFile(path.join(CLIENT_BUILD_PATH, 'index.html'));
    });
} else {
    console.error(`[Server ERROR] Client Build NOT found at ${CLIENT_BUILD_PATH}`);
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Multi-Drive Server running at http://0.0.0.0:${PORT}`);
    console.log(`[Server] User Data Path: ${APP_DATA_DIR}`);
});
