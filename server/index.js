const express = require('express');
const { v2: webdavServer } = require('webdav-server');
const { createClient } = require('webdav');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const mime = require('mime-types');
const multer = require('multer');
const { encrypt, decrypt } = require('./utils/crypto');

const app = express();
const PORT = 8000;
const STORAGE_DIR = os.homedir(); // Default to User Home directory
const CONFIG_FILE = path.join(__dirname, 'drives.json');

// Ensure storage directory exists
fs.ensureDirSync(STORAGE_DIR);
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
        password: config.password // Config already has decrypted password
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
    const safeSuffix = path.normalize(userPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\]+/, '');
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
                return {
                    name: file,
                    path: relPath, // Return consistent path format
                    isDirectory: stats.isDirectory(),
                    size: stats.size,
                    mtime: stats.mtime,
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
            // Stream from remote WebDAV to client
            const stream = client.createReadStream(reqPath);
            const fileName = path.basename(reqPath);
            res.setHeader('Content-Type', mime.lookup(fileName) || 'application/octet-stream');
            
            stream.on('error', (streamErr) => {
                console.error('Stream Error:', streamErr);
                if (!res.headersSent) res.status(502).send('Proxy Stream Error');
                else res.end(); // Close connection if headers already sent
            });

            stream.pipe(res);
        }
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// POST /api/mkdir
app.post('/api/mkdir', async (req, res) => {
    try {
        const { path: reqPath, drive: driveId = 'local' } = req.body;
        const config = await getDriveConfig(driveId);

        if (config.type === 'local') {
            await fs.ensureDir(resolveSafePath(reqPath));
        } else {
            const client = getWebDAVClient(config);
            await client.createDirectory(reqPath);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/delete
app.post('/api/delete', async (req, res) => {
    try {
        const { items, drive: driveId = 'local' } = req.body;
        const config = await getDriveConfig(driveId);

        if (config.type === 'local') {
            await Promise.all(items.map(async itemPath => {
                const safePath = path.normalize(itemPath).replace(/^(\.\.[/\\])+/, '');
                await fs.remove(path.join(STORAGE_DIR, safePath));
            }));
        } else {
            const client = getWebDAVClient(config);
            await Promise.all(items.map(item => client.deleteFile(item.replace(/^\/+/, ''))));
        }
        res.json({ success: true });
    } catch (err) {
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
                // ... (existing move logic) ...
                const safeItem = path.normalize(itemPath).replace(/^(\.\.[/\\])+/, ''); // Simplified relative
                const absItem = path.join(STORAGE_DIR, safeItem);
                
                // Destination is a FOLDER in move API
                const safeDest = path.normalize(destination).replace(/^(\.\.[/\\])+/, '');
                const absDestDir = path.join(STORAGE_DIR, safeDest);
                const absNewPath = path.join(absDestDir, path.basename(safeItem));
                
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

            // 2. Write Stream
            if (dstConfig.type === 'local') {
                const absDestDir = resolveSafePath(destPath);
                await fs.ensureDir(absDestDir);
                const absDestFile = path.join(absDestDir, fileName);
                const writeStream = fs.createWriteStream(absDestFile);
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
        if (!oldPath || !newName) return res.status(400).json({ error: 'Missing parameters' });

        const config = await getDriveConfig(driveId);

        if (config.type === 'local') {
            // Local Rename
            const safeOld = path.normalize(oldPath).replace(/^(\.\.[/\\])+/, '');
            const absOld = path.join(STORAGE_DIR, safeOld);
            
            // Construct new path in the same directory
            const safeDir = path.dirname(safeOld);
            const absNew = path.join(STORAGE_DIR, safeDir, newName); // Same dir, new name

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

// Multer & Upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const { path: reqPath = '/', drive: driveId = 'local' } = req.query;
        if (driveId === 'local') {
            const uploadDir = path.join(STORAGE_DIR, path.normalize(reqPath).replace(/^(\.\.[/\\])+/, ''));
            fs.ensureDirSync(uploadDir);
            cb(null, uploadDir);
        } else {
            cb(null, '/tmp'); // Temp for remote upload
        }
    },
    filename: (req, file, cb) => cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8'))
});
const upload = multer({ storage });

app.post('/api/upload', upload.array('files'), async (req, res) => {
    try {
        const { path: reqPath = '/', drive: driveId = 'local' } = req.query;
        const config = await getDriveConfig(driveId);

        if (config.type !== 'local') {
            const client = getWebDAVClient(config);
            await Promise.all(req.files.map(async file => {
                // Strip leading slash to avoid double slash with base URL
                const cleanReqPath = reqPath.replace(/^\/+/, '');
                const remotePath = path.posix.join(cleanReqPath, file.filename);
                const fileBuffer = await fs.readFile(file.path);
                await client.putFileContents(remotePath, fileBuffer);
                await fs.remove(file.path); 
            }));
        }
        res.json({ success: true });
    } catch (err) {
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
if (fs.existsSync(CLIENT_BUILD_PATH)) {
    app.use(express.static(CLIENT_BUILD_PATH));
    
    // Handle SPA routing: return index.html for any unknown non-API routes
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/webdav')) {
            return next();
        }
        res.sendFile(path.join(CLIENT_BUILD_PATH, 'index.html'));
    });
}

app.listen(PORT, () => {
    console.log(`🚀 Multi-Drive Server running at http://localhost:${PORT}`);
});
