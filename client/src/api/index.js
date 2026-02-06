import axios from 'axios';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { createClient } from 'webdav';
import { Buffer } from 'buffer';
import { encrypt, decrypt } from '../utils/clientCrypto';

// --- Native Plugin Interface ---
const WebDavNative = registerPlugin('WebDavNative');

// --- Global Event Listener System ---
const uploadCallbacks = {}; // Map: id -> callback(info)
let globalUploadListener = null;

const initGlobalUploadListener = async () => {
    if (!Capacitor.isNativePlatform() || globalUploadListener) return;
    
    console.log('[NativeWebDAV] Initializing global upload listener');
    globalUploadListener = await WebDavNative.addListener('uploadProgress', (info) => {
        console.log('[NativeWebDAV] Global Event:', JSON.stringify(info));
        console.log('[NativeWebDAV] Active Callbacks:', Object.keys(uploadCallbacks));

        const { id } = info;
        if (id && uploadCallbacks[id]) {
            uploadCallbacks[id](info);
        } else {
             // Fallback: Dispatch to all active callbacks if ID is missing
             // This assumes sequential uploads (which we enforce) or that progress events are generic enough
             Object.values(uploadCallbacks).forEach(cb => cb(info));
        }
    });
};

// Initialize immediately if native
if (Capacitor.isNativePlatform()) {
    initGlobalUploadListener();
}

// --- Critical Polyfill for Mobile ---
// Ensure Buffer is available globally
if (typeof window !== 'undefined') {
    window.Buffer = window.Buffer || Buffer;
    window.global = window.global || window; 
}

// --- Cancellation System ---
const cancellationMap = {}; // taskId -> { cancelled: true, nativeId: string }

// --- Custom Native WebDAV Client (Bypasses CORS & CapacitorHttp) ---
class NativeWebDAVClient {
    // ... existing methods ...
    constructor(config) {
        // Normalize URL: remove ALL trailing slashes
        this.url = config.url.replace(/\/+$/, ''); 
        
        // Extract the base path from the URL (e.g. "https://host/dav" -> "/dav")
        try {
            const urlObj = new URL(this.url);
            this.origin = urlObj.origin; // https://host
            this.basePath = urlObj.pathname.replace(/\/+$/, ''); // /dav
            if (this.basePath === '/') this.basePath = '';
        } catch (e) {
            this.origin = this.url;
            this.basePath = '';
        }

        this.username = config.username;
        this.password = config.password;
        const creds = `${this.username}:${this.password}`;
        this.authHeader = 'Basic ' + btoa(encodeURIComponent(creds).replace(/%([0-9A-F]{2})/g,
            function toSolidBytes(match, p1) {
                return String.fromCharCode('0x' + p1);
        }));
    }

    _resolveUrl(path) {
        // If path is empty or root, return base URL
        if (!path || path === '/') return this.url + '/';

        // Ensure path starts with /
        const cleanPath = path.startsWith('/') ? path : '/' + path;
        
        // Helper to encode path segments but keep slashes
        // However, input 'path' from webdav lib (or our UI) is usually NOT encoded
        // But if it IS encoded, we shouldn't encode again.
        // Simple heuristic: decode it first, then encode.
        const encodedPath = cleanPath.split('/').map(p => encodeURIComponent(decodeURIComponent(p))).join('/');

        // Check if path already starts with our base path (e.g. /dav/folder1)
        if (this.basePath && cleanPath.startsWith(this.basePath)) {
             // Re-encode the base path part too if needed? 
             // Ideally we just construct full URL.
             // Let's assume input 'path' is human-readable (not encoded).
             
             // If input was absolute path matching basepath
             if (cleanPath === this.basePath || cleanPath === this.basePath + '/') {
                 return this.url + '/';
             }
             
             // It's tricky because cleanPath might be /dav/中文
             // We want https://host/dav/%E4%B8%AD%E6%96%87
             
             // If cleanPath starts with basePath, strip basePath and append to url
             if (cleanPath.startsWith(this.basePath)) {
                 const relPath = cleanPath.substring(this.basePath.length);
                 const encodedRel = relPath.split('/').map(p => encodeURIComponent(decodeURIComponent(p))).join('/');
                 return this.url + encodedRel;
             }
        }

        // Relative path case
        // encode the path parts
        const encodedRelative = cleanPath.split('/').map(p => encodeURIComponent(decodeURIComponent(p))).join('/');
        return this.url + encodedRelative;
    }

    // Update _request to pass bodyIsBase64
    async _request(method, path, options = {}) {
        const fullUrl = this._resolveUrl(path);
        const headers = {
            'Authorization': this.authHeader,
            ...options.headers
        };

        console.log(`[NativeWebDAV] ${method} ${fullUrl} (Path: ${path})`);

        const res = await WebDavNative.request({
            url: fullUrl,
            method: method,
            headers: headers,
            body: options.data || '',
            bodyIsBase64: !!options.bodyIsBase64,
            responseType: options.responseType || 'text',
            id: options.id
        });

        if (res.status >= 400) {
            const err = new Error(`WebDAV Error: ${res.status}`);
            err.response = { status: res.status, data: res.data };
            throw err;
        }
        return res;
    }

    async getDirectoryContents(path) {
        // Ensure directory path ends with slash for PROPFIND (good practice)
        // But _request handles resolution.
        const res = await this._request('PROPFIND', path, {
            headers: { 'Depth': '1', 'Content-Type': 'application/xml' }
        });
        
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(res.data, "text/xml");
        
        // Helper to find elements regardless of namespace prefix (dav:response, d:response, or just response)
        const getEls = (parent, tagName) => {
            const list = [];
            for (let i = 0; i < parent.children.length; i++) {
                const node = parent.children[i];
                if (node.localName === tagName) list.push(node);
            }
            return list;
        };
        const getEl = (parent, tagName) => getEls(parent, tagName)[0];
        const getText = (parent, tagName) => {
            const el = getEl(parent, tagName);
            return el ? el.textContent : '';
        };

        // Find <response> elements (usually under <multistatus>)
        let responses = [];
        const multiStatus = getEl(xmlDoc, 'multistatus') || xmlDoc.documentElement;
        if (multiStatus) responses = getEls(multiStatus, 'response');
        
        const items = [];
        for (const resp of responses) {
            const href = getText(resp, 'href');
            const propstat = getEl(resp, 'propstat');
            if (!propstat) continue;
            const prop = getEl(propstat, 'prop');
            if (!prop) continue;
            
            const resType = getEl(prop, 'resourcetype');
            const isDir = resType && getEl(resType, 'collection') !== undefined;
            
            const size = parseInt(getText(prop, 'getcontentlength')) || 0;
            const lastMod = getText(prop, 'getlastmodified');

            // Extract basename
            const decodedHref = decodeURIComponent(href).replace(/\/$/, '');
            const basename = decodedHref.split('/').pop();
            
            items.push({
                basename: basename || '', 
                filename: decodeURIComponent(href), 
                type: isDir ? 'directory' : 'file',
                size: size,
                lastmod: lastMod,
                mime: isDir ? null : 'application/octet-stream'
            });
        }
        
        // Filter out the requested directory itself
        // We resolve the requested path to its absolute href form to compare
        
        // Construct the expected href for the requested path
        // If path is "/", expected href is basePath/
        let reqHref = this._resolveUrl(path).replace(this.origin, '');
        // Normalize: ensure it ends with / for directory comparison
        if (!reqHref.endsWith('/')) reqHref += '/';
        // Normalize: decode URI to compare with our decoded item filenames
        reqHref = decodeURIComponent(reqHref);
        
        return items.filter(item => {
             // item.filename is already decoded in previous loop
             let itemHref = item.filename;
             if (item.type === 'directory' && !itemHref.endsWith('/')) itemHref += '/';
             
             // Compare with requested href (case sensitive? usually yes)
             if (itemHref === reqHref) return false;
             
             return true;
        });
    }

    async createDirectory(path) {
        await this._request('MKCOL', path);
    }

    async deleteFile(path) {
        await this._request('DELETE', path);
    }

    async moveFile(oldPath, newPath) {
        // Destination header must be full URL
        const destUrl = this._resolveUrl(newPath);
        await this._request('MOVE', oldPath, {
            headers: { 'Destination': destUrl, 'Overwrite': 'T' }
        });
    }
    
    async putFileContents(path, content, options = {}) {
        const data = Buffer.isBuffer(content) ? content.toString('base64') : content;
        await this._request('PUT', path, {
             data: data,
             headers: { 'Content-Type': 'application/octet-stream' },
             bodyIsBase64: true,
             id: options.id
        });
    }

    async streamUploadFile(path, sourcePath, id) {
        const fullUrl = this._resolveUrl(path);
        const headers = {
            'Authorization': this.authHeader,
            'Content-Type': 'application/octet-stream',
            'X-Capacitor-Id': id // Backup ID
        };
        console.log(`[NativeWebDAV] streamUploadFile calling native upload with id: ${id}`);
        await WebDavNative.upload({
            url: fullUrl,
            method: 'PUT',
            headers: headers,
            sourcePath: sourcePath,
            id: id
        });
    }

    async streamDownloadFile(remotePath, localPath, id) {
        const fullUrl = this._resolveUrl(remotePath);
        const headers = {
            'Authorization': this.authHeader
        };
        await WebDavNative.download({
            url: fullUrl,
            destPath: localPath,
            headers: headers,
            id: id
        });
    }

    async getFileContents(path, options = {}) {
        const res = await this._request('GET', path, {
            ...options,
            responseType: options.format === 'binary' ? 'base64' : 'text',
            id: options.id
        });
        return res.data; // Base64 string if format is binary
    }

    async getQuota() {
        try {
            const res = await this._request('PROPFIND', '/', {
                headers: { 
                    'Depth': '0', 
                    'Content-Type': 'application/xml',
                    // Request specific quota properties
                    // Some servers need explicit body to return quota
                },
                data: `<?xml version="1.0" encoding="utf-8" ?>
                    <D:propfind xmlns:D="DAV:">
                        <D:prop>
                            <D:quota-available-bytes/>
                            <D:quota-used-bytes/>
                        </D:prop>
                    </D:propfind>`
            });

            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(res.data, "text/xml");
            
            const getText = (tagName) => {
                const els = xmlDoc.getElementsByTagName(tagName);
                if (els.length === 0) {
                    // Try with namespace prefix 'D:' or 'd:' if simple tag fail
                    const elsNS = xmlDoc.getElementsByTagNameNS("DAV:", tagName);
                    return elsNS.length > 0 ? elsNS[0].textContent : null;
                }
                return els[0].textContent;
            };
            
            // Try to find quota props deeply
            // They might be namespaced like <D:quota-used-bytes>
            
            // Helper to search text content of a localName ignoring namespace
            const findVal = (name) => {
                const all = xmlDoc.getElementsByTagName("*");
                for (let i=0; i<all.length; i++) {
                    if (all[i].localName === name) return all[i].textContent;
                }
                return null;
            }

            const used = parseInt(findVal('quota-used-bytes')) || 0;
            const available = parseInt(findVal('quota-available-bytes')) || 0;
            
            // If available is huge or missing, server might not report it correctly
            if (used || available) {
                return { used, available, total: used + available };
            }
            return null;
        } catch (e) {
            console.warn('[WebDAV] Failed to get quota:', e);
            return null;
        }
    }
}

// --- Helper: Get WebDAV Client ---
const getWebDAVClient = (driveConfig) => {
    console.log(`[WebDAV] Creating client for: ${driveConfig.url}`);
    
    // Decrypt password (handles both encrypted storage and plain text form input)
    const password = decrypt(driveConfig.password);

    // If on Mobile (Native), use our Custom Native Client
    if (Capacitor.isNativePlatform()) {
        return new NativeWebDAVClient({ ...driveConfig, password });
    }

    return createClient(driveConfig.url, {
        username: driveConfig.username,
        password: password
    });
};

// --- Helper: Normalize Native File Object ---
const normalizeNativeFile = (fileInfo, parentPath) => {
  // Capacitor Filesystem returns different structure
  return {
    name: fileInfo.name,
    path: parentPath === '/' ? `/${fileInfo.name}` : `${parentPath}/${fileInfo.name}`,
    isDirectory: fileInfo.type === 'directory',
    size: fileInfo.size || 0,
    mtime: fileInfo.mtime || Date.now(),
    type: fileInfo.type === 'directory' ? 'folder' : 'application/octet-stream' // Simplified
  };
};

// --- Strategy 1: Server API (Node.js/Electron) ---
const ServerAPI = {
  getFiles: async (path, driveId) => {
    const res = await axios.get(`/api/files?path=${encodeURIComponent(path)}&drive=${driveId}`);
    return res.data.files;
  },
  createFolder: async (path, driveId) => {
    await axios.post('/api/mkdir', { path, drive: driveId });
  },
  deleteItems: async (items, driveId) => {
    await axios.post('/api/delete', { items, drive: driveId });
  },
  renameItem: async (oldPath, newName, currentPath, driveId) => {
    await axios.post('/api/rename', { oldPath, newName, path: currentPath, drive: driveId });
  },
  moveItems: async (items, destination, driveId) => {
    await axios.post('/api/move', { items, destination, drive: driveId });
  },
  crossDriveTransfer: async (items, sourceDriveId, destPath, destDriveId, isMove = false, onProgress, onItemComplete) => {
      for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const itemPath = item.path || item;
          const fileName = itemPath.split('/').pop();
          
          if (onProgress) onProgress(i + 1, items.length, fileName);
          
          await axios.post('/api/transfer', {
              items: [itemPath],
              sourceDrive: sourceDriveId,
              destDrive: destDriveId,
              destPath: destPath,
              move: isMove
          });

          if (onItemComplete) onItemComplete(fileName);
      }
  },
  uploadFiles: async (path, files, driveId, onProgress, onItemComplete) => {
    const formData = new FormData();
    files.forEach(f => formData.append('files', f));
    
    // Axios upload progress is for the WHOLE batch
    const config = { 
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (progressEvent) => {
          if (onProgress && progressEvent.total) {
              // Aggregate progress for the batch
              onProgress(1, 1, 'Uploading...', 0, progressEvent.loaded, progressEvent.total);
          }
      }
    };

    await axios.post(`/api/upload?path=${encodeURIComponent(path)}&drive=${driveId}`, formData, config);
    
    if (onItemComplete) {
        files.forEach(f => onItemComplete(f.name));
    }
  },
  getDrives: async () => {
    const res = await axios.get(`/api/drives?t=${Date.now()}`);
    return res.data;
  },
  addDrive: async (drive) => {
    const res = await axios.post('/api/drives', drive);
    return res.data;
  },
  updateDrive: async (id, data) => {
    await axios.patch(`/api/drives/${id}`, data);
  },
  testConnection: async (config) => {
    await axios.post('/api/drives/test', config);
  },
  removeDrive: async (id) => {
    await axios.delete(`/api/drives/${id}`);
  },
  getFileUrl: (path, driveId) => `/api/raw?path=${encodeURIComponent(path)}&drive=${driveId}`,
  getThumbnailUrl: (path, driveId) => `/api/preview?path=${encodeURIComponent(path)}&drive=${driveId}`,
  getFileBlob: async (path, driveId) => {
      const res = await axios.get(`/api/raw?path=${encodeURIComponent(path)}&drive=${driveId}`, { responseType: 'blob' });
      return res.data;
  },
  readFileText: async (path, driveId) => {
      const res = await axios.get(`/api/raw?path=${encodeURIComponent(path)}&drive=${driveId}`, { responseType: 'text' });
      return res.data;
  },
  searchItems: async (query, driveId, rootPath = '/') => {
    const res = await axios.get(`/api/search?query=${encodeURIComponent(query)}&drive=${driveId}&path=${encodeURIComponent(rootPath)}`);
    return res.data;
  },
  requestPermissions: async () => {}
};

// --- Helper: Base64 to Blob ---
const base64ToBlob = (base64, mimeType = 'application/octet-stream') => {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
};

let cachedServerUrl = null;

// --- Helper: Notifications ---
const updateNotify = async (id, title, desc, progress, max) => {
    if (!Capacitor.isNativePlatform()) return;
    try {
        await WebDavNative.updateNotification({
            id, title, description: desc, progress, max
        });
    } catch(e) {}
};

const cancelNotify = async (id) => {
    if (!Capacitor.isNativePlatform()) return;
    try {
        await WebDavNative.cancelNotification({ id });
    } catch(e) {}
};

// --- Strategy 2: Native API (Capacitor) ---
const NativeAPI = {
  getFiles: async (reqPath, driveId) => {
    if (driveId !== 'local') {
       // WebDAV Logic
       const drives = await NativeAPI.getDrives();
       const config = drives.find(d => d.id === driveId);
       if (!config) throw new Error("Drive not found");
       
       const client = getWebDAVClient(config);
       const items = await client.getDirectoryContents(reqPath);
       
       // Normalize WebDAV items to App format
       return items.map(item => ({
           name: item.basename,
           path: item.filename, 
           isDirectory: item.type === 'directory',
           size: item.size,
           mtime: item.lastmod ? (new Date(item.lastmod).getTime() || Date.now()) : Date.now(),
           type: item.type === 'directory' ? 'folder' : (item.mime || 'application/octet-stream')
       }));
    }
    
    // Convert Web Path to Native Path
    // Native Root is usually 'Documents' or 'ExternalStorage'
    
    let nativeFiles = [];

    try {
      // Request permissions first
      try {
        const permStatus = await Filesystem.requestPermissions();
        
        // Request MANAGE_EXTERNAL_STORAGE for Android 11+
        if (Capacitor.getPlatform() === 'android') {
             try {
                 await WebDavNative.requestManageStoragePermission();
             } catch (e) { console.warn('Failed to request manage storage', e); }
        }
      } catch (e) {
        console.warn('[Native] Failed to request permissions:', e);
      }

      // Use ExternalStorage to see root of /storage/emulated/0
      const targetDir = Directory.ExternalStorage; 

      console.log(`[Native] Listing files in ${targetDir} at path: ${reqPath}`);
      const res = await Filesystem.readdir({
        path: reqPath,
        directory: targetDir
      });
      console.log(`[Native] Found ${res.files.length} items.`);
      
      nativeFiles = res.files.map(f => normalizeNativeFile(f, reqPath));

    } catch (e) {
      console.error("[Native] Read Error:", e);
      
      // Fallback: Try Native Plugin for restricted directories (e.g. /Android/data)
      if (Capacitor.getPlatform() === 'android') {
           try {
               console.log(`[Native] Filesystem.readdir failed, trying WebDavNative.listDirectory for ${reqPath}`);
               const cleanPath = reqPath.startsWith('/') ? reqPath : '/' + reqPath;
               const res = await WebDavNative.listDirectory({ path: cleanPath });
               
               // Normalize Native Plugin result
               nativeFiles = res.items.map(item => ({
                   name: item.name,
                   path: cleanPath === '/' ? `/${item.name}` : `${cleanPath}/${item.name}`,
                   isDirectory: item.isDirectory,
                   size: item.size || 0,
                   mtime: item.mtime || Date.now(),
                   type: item.isDirectory ? 'folder' : 'application/octet-stream'
               }));
           } catch (innerErr) {
               console.warn('[Native] WebDavNative.listDirectory also failed:', innerErr);
           }
      }
    }

    // Enhance with itemCount for directories
    if (nativeFiles.length > 0) {
        await Promise.all(nativeFiles.map(async (file) => {
            if (file.isDirectory) {
                try {
                    // Try Filesystem first
                    const sub = await Filesystem.readdir({ 
                        path: file.path, 
                        directory: Directory.ExternalStorage 
                    });
                    file.itemCount = sub.files.length;
                } catch (e) {
                    // Fallback to Native Plugin if Filesystem fails (e.g. Android 11+ restrictions)
                     if (Capacitor.getPlatform() === 'android') {
                        try {
                            const sub = await WebDavNative.listDirectory({ path: file.path });
                            file.itemCount = sub.items.length;
                        } catch (inner) {
                            file.itemCount = 0;
                        }
                     } else {
                        file.itemCount = 0;
                     }
                }
            }
        }));
    }

    return nativeFiles;
  },

  createFolder: async (path, driveId) => {
    if (driveId !== 'local') {
       const drives = await NativeAPI.getDrives();
       const config = drives.find(d => d.id === driveId);
       const client = getWebDAVClient(config);
       await client.createDirectory(path);
       return;
    }
    try {
        await Filesystem.mkdir({
          path: path,
          directory: Directory.ExternalStorage,
          recursive: true // Like ensureDir
        });
    } catch (e) {
        // Fallback to Native Plugin for restricted directories (e.g. /Android/data)
        if (Capacitor.getPlatform() === 'android') {
            try {
                console.log(`[Native] Filesystem.mkdir failed, trying WebDavNative.createDirectory for ${path}`);
                // Ensure path starts with /
                const cleanPath = path.startsWith('/') ? path : '/' + path;
                await WebDavNative.createDirectory({ path: cleanPath });
                return;
            } catch (innerErr) {
                console.error('[Native] WebDavNative.createDirectory also failed:', innerErr);
                throw e; // Throw original error
            }
        }
        throw e;
    }
  },

  deleteItems: async (items, driveId) => {
    if (driveId !== 'local') {
       const drives = await NativeAPI.getDrives();
       const config = drives.find(d => d.id === driveId);
       const client = getWebDAVClient(config);
       await Promise.all(items.map(item => client.deleteFile(item)));
       return;
    }
    await Promise.all(items.map(async itemPath => {
      try {
        const stat = await Filesystem.stat({ path: itemPath, directory: Directory.ExternalStorage });
        if (stat.type === 'directory') {
          await Filesystem.rmdir({
            path: itemPath,
            directory: Directory.ExternalStorage,
            recursive: true
          });
        } else {
          await Filesystem.deleteFile({
            path: itemPath,
            directory: Directory.ExternalStorage
          });
        }
      } catch (e) {
        console.error('[Native] Delete failed for', itemPath, e);
        // Fallback: just try deleteFile if stat fails
        try {
          await Filesystem.deleteFile({ path: itemPath, directory: Directory.ExternalStorage });
        } catch (inner) {}
      }
    }));
  },
  
  renameItem: async (oldPath, newName, currentPath, driveId) => {
      if (driveId !== 'local') {
        const drives = await NativeAPI.getDrives();
        const config = drives.find(d => d.id === driveId);
        const client = getWebDAVClient(config);
        
        // Construct new path
        const pathParts = oldPath.split('/');
        pathParts.pop();
        const newPath = [...pathParts, newName].join('/'); // Simple join for now
        
        await client.moveFile(oldPath, newPath);
        return;
      }
      // Capacitor 5+ supports rename directly via rename() or move()
      // We construct the new path manually
      const pathParts = oldPath.split('/');
      pathParts.pop(); // remove old name
      const baseDir = pathParts.join('/');
      const newPath = `${baseDir}/${newName}`;

      await Filesystem.rename({
          from: oldPath,
          to: newPath,
          directory: Directory.ExternalStorage
      });
  },

  moveItems: async (items, destination, driveId) => {
      if (driveId !== 'local') {
        const drives = await NativeAPI.getDrives();
        const config = drives.find(d => d.id === driveId);
        const client = getWebDAVClient(config);
        
        await Promise.all(items.map(item => {
             const destPath = `${destination}/${item.split('/').pop()}`.replace('//', '/');
             return client.moveFile(item, destPath);
        }));
        return;
      }
      
      // Implement Local Move
      await Promise.all(items.map(async itemPath => {
          const fileName = itemPath.split('/').pop();
          // Construct destination path
          // Destination is a folder path like /Download
          // New path should be /Download/fileName
          const destPath = (destination === '/' ? '' : destination) + '/' + fileName;
          
          if (itemPath !== destPath) {
              await Filesystem.rename({
                  from: itemPath,
                  to: destPath,
                  directory: Directory.ExternalStorage,
                  toDirectory: Directory.ExternalStorage
              });
          }
      }));
  },
  
  crossDriveTransfer: async (items, sourceDriveId, destPath, destDriveId, isMove = false, onProgress, onItemComplete) => {
      console.log(`[CrossDrive] Transferring ${items.length} items from ${sourceDriveId} to ${destDriveId} (Move: ${isMove})`);
      
      const NOTIFY_ID = 9999;
      let transferredBytes = 0;
      const startTime = Date.now();
      
      if (Capacitor.isNativePlatform()) {
           await WebDavNative.startBackgroundWork();
      }

      await updateNotify(NOTIFY_ID, isMove ? "Moving Files" : "Copying Files", "Preparing...", 0, items.length);

      // ... (readContent and writeContent helpers remain same) ...
      // Helper to read content
      const readContent = async (path, driveId, transferId) => {
          if (driveId === 'local') {
              const res = await Filesystem.readFile({
                  path: path,
                  directory: Directory.ExternalStorage
              });
              return res.data; // Base64 string
          } else {
              const drives = await NativeAPI.getDrives();
              const config = drives.find(d => d.id === driveId);
              const client = getWebDAVClient(config);
              
              // Get Base64 content
              const base64Data = await client.getFileContents(path, { format: 'binary', id: transferId });
              return base64Data;
          }
      };

      // Helper to write content
      const writeContent = async (path, content, driveId, transferId) => {
          const fileName = path.split('/').pop();
          const cleanDest = destPath === '/' ? '' : destPath.replace(/\/+$/, '');
          const targetPath = cleanDest + '/' + fileName;

          if (driveId === 'local') {
              await Filesystem.writeFile({
                  path: targetPath,
                  data: content,
                  directory: Directory.ExternalStorage,
                  recursive: true // Ensure folders exist
              });
          } else {
              const drives = await NativeAPI.getDrives();
              const config = drives.find(d => d.id === driveId);
              const client = getWebDAVClient(config);
              // Ensure we pass bodyIsBase64: true
              await client.putFileContents(targetPath, content, { id: transferId });
          }
      };

      try {
        // Execution Loop
        for (let i = 0; i < items.length; i++) {
            // Check cancellation before starting item
            const taskId = items[i].id; // Passed from App.jsx
            
            // Generate unique ID for this transfer (Use taskId if available, otherwise generate)
            const transferId = taskId || `transfer_${Date.now()}_${i}`;

            if (taskId && cancellationMap[taskId]?.cancelled) {
                console.log(`[CrossDrive] Task ${taskId} cancelled before start.`);
                if (onProgress) onProgress(i + 1, items.length, items[i].path.split('/').pop(), 0, 0, 0); // Update UI?
                continue; // Skip
            }

            const itemPath = items[i].path || items[i]; // Handle object or string
            const itemName = itemPath.split('/').pop();
            
            // Check if item is directory
            let isDirectory = false;
            try {
                if (sourceDriveId === 'local') {
                    const stat = await Filesystem.stat({ path: itemPath, directory: Directory.ExternalStorage });
                    isDirectory = stat.type === 'directory';
                } else {
                    const drives = await NativeAPI.getDrives();
                    const config = drives.find(d => d.id === sourceDriveId);
                    const client = getWebDAVClient(config);
                    const stat = await client.stat(itemPath);
                    isDirectory = stat.type === 'directory';
                }
            } catch (e) {
                console.warn(`[CrossDrive] Failed to stat ${itemPath}, assuming file:`, e);
            }

            if (isDirectory) {
                console.log(`[CrossDrive] Processing directory: ${itemPath}`);
                // 1. Create destination directory
                const newDestPath = destPath === '/' ? `/${itemName}` : `${destPath}/${itemName}`;
                await NativeAPI.createFolder(newDestPath, destDriveId);
                
                // 2. Get children
                const children = await NativeAPI.getFiles(itemPath, sourceDriveId);
                
                // 3. Recurse (Keep same task ID logic? Complex. For now, treat children as sub-tasks but maybe we lose granular progress on the folder itself in UI)
                // We pass children as objects but without ID to generate new ones, or we could try to map them. 
                // Actually, simply calling recursively is safest.
                // Note: The UI progress for the *folder* task will effectively be "stuck" or we need to update it.
                // Current UI only tracks top-level tasks.
                const childItems = children.map(c => ({ path: c.path, id: null })); // Children get new auto-IDs internally
                
                await NativeAPI.crossDriveTransfer(
                    childItems, 
                    sourceDriveId, 
                    newDestPath, 
                    destDriveId, 
                    false, // Recursive copy children (handling delete later if move)
                    (idx, total, name, speed, cur, tot) => {
                        // Optional: Bubble up progress? 
                        // It's hard to map child bytes to parent folder total bytes without pre-calc.
                        // Just report activity on the parent task?
                        if (onProgress) onProgress(i + 1, items.length, `${itemName}/${name}`, speed, cur, tot);
                    }
                );
                
                // 4. If Move, delete source directory after recursion
                if (isMove) {
                    await NativeAPI.deleteItems([itemPath], sourceDriveId);
                }
                
                if (onItemComplete) onItemComplete(itemName);
                continue; // Done with this directory item
            }

            await updateNotify(NOTIFY_ID, isMove ? "Moving Files" : "Copying Files", `Processing ${itemName}`, i, items.length);

            // Report start of item
            if (onProgress) onProgress(i + 1, items.length, itemName, 0, 0, 0);

            try {
                if (sourceDriveId === 'local' && destDriveId === 'local') {
                    // Optimized Local -> Local Copy
                    console.log(`[CrossDrive] Optimizing Local -> Local Copy for ${itemPath}`);
                    const cleanDest = destPath === '/' ? '' : destPath.replace(/\/+$/, '');
                    const targetPath = cleanDest + '/' + itemName;
                    
                    await Filesystem.copy({
                        from: itemPath,
                        to: targetPath,
                        directory: Directory.ExternalStorage,
                        toDirectory: Directory.ExternalStorage
                    });
                    
                    // Delete Source (Only if Move) - Handled by moveItems? 
                    // No, handlePaste calls crossDriveTransfer with isMove=false for Copy.
                    // If isMove=true, it calls api.moveItems directly in App.jsx.
                    // So this block is ONLY for Copy.
                    
                    // We need to report progress? Filesystem.copy doesn't report progress.
                    // We can just report 0 -> 100% or fake it.
                    // For large files, it might block.
                    // But it's native, so it's fast and won't OOM JS.
                    
                    // Get size for progress
                    let fileSize = 0;
                    try {
                        const stat = await Filesystem.stat({ path: itemPath, directory: Directory.ExternalStorage });
                        fileSize = stat.size;
                    } catch(e) {}
                    
                    if (onProgress) onProgress(i + 1, items.length, itemName, 0, fileSize, fileSize);

                } else if (sourceDriveId === 'local' && destDriveId !== 'local') {
                    // Optimized Local -> WebDAV Stream
                    console.log(`[CrossDrive] Optimizing Local -> WebDAV for ${itemPath}`);
                    const drives = await NativeAPI.getDrives();
                    const config = drives.find(d => d.id === destDriveId);
                    const client = getWebDAVClient(config);
                    
                    const cleanDest = destPath === '/' ? '' : destPath.replace(/\/+$/, '');
                    const targetPath = cleanDest + '/' + itemName;
                    
                    let fileSize = 0;
                    try {
                        const stat = await Filesystem.stat({ path: itemPath, directory: Directory.ExternalStorage });
                        fileSize = stat.size;
                    } catch(e) { console.warn('Failed to get file size', e); }

                    let lastUpdate = Date.now();
                    let lastBytes = 0;

                    // Register temporary callback
                    uploadCallbacks[transferId] = (info) => {
                        if (cancellationMap[transferId]?.cancelled) return;
                        const { uploaded, total } = info;
                        const now = Date.now();
                        const timeDiff = (now - lastUpdate) / 1000;
                        
                        let speed = 0;
                        if (timeDiff > 0) {
                             const bytesDiff = uploaded - lastBytes;
                             speed = bytesDiff / timeDiff;
                        }
                        
                        // Fallback to average if delta is weird or start
                        if (speed === 0 && uploaded > 0) {
                             const elapsed = (Date.now() - startTime) / 1000;
                             speed = (transferredBytes + uploaded) / elapsed;
                        }

                        lastUpdate = now;
                        lastBytes = uploaded;

                        const effectiveTotal = total > 0 ? total : fileSize;
                        if (onProgress) onProgress(i + 1, items.length, itemName, speed, uploaded, effectiveTotal);
                    };

                    try {
                        await client.streamUploadFile(targetPath, itemPath, transferId);
                        transferredBytes += fileSize; // Accumulate bytes
                    } finally {
                        delete uploadCallbacks[transferId];
                    }
                    
                    // Delete Source (Only if Move)
                    if (isMove) {
                        await Filesystem.deleteFile({ path: itemPath, directory: Directory.ExternalStorage });
                    }
                    
                } else if (sourceDriveId !== 'local' && destDriveId === 'local') {
                    // Optimized WebDAV -> Local Stream (New)
                    console.log(`[CrossDrive] Optimizing WebDAV -> Local for ${itemPath}`);
                    const drives = await NativeAPI.getDrives();
                    const config = drives.find(d => d.id === sourceDriveId);
                    const client = getWebDAVClient(config);
                    
                    const cleanDest = destPath === '/' ? '' : destPath.replace(/\/+$/, '');
                    const targetPath = cleanDest + '/' + itemName;
                    
                    let downloadListener = null;
                    let lastUpdate = Date.now();
                    let lastBytes = 0; // Bytes within this file
                    let fileTotalBytes = 0;

                    if (Capacitor.isNativePlatform()) {
                         downloadListener = await WebDavNative.addListener('downloadProgress', (info) => {
                             if (info.id === transferId) {
                                 if (cancellationMap[transferId]?.cancelled) return;
                                 const { downloaded, total } = info;
                                 const now = Date.now();
                                 const timeDiff = (now - lastUpdate) / 1000;
                                 
                                 let speed = 0;
                                 if (timeDiff > 0) {
                                     const bytesDiff = downloaded - lastBytes;
                                     speed = bytesDiff / timeDiff;
                                 }
                                 
                                  // Fallback
                                 if (speed === 0 && downloaded > 0) {
                                     const elapsed = (Date.now() - startTime) / 1000;
                                     speed = (transferredBytes + downloaded) / elapsed;
                                 }

                                 lastUpdate = now;
                                 lastBytes = downloaded;
                                 fileTotalBytes = total;
                                 if (onProgress) onProgress(i + 1, items.length, itemName, speed, downloaded, total);
                             }
                         });
                    }

                    try {
                        await client.streamDownloadFile(itemPath, targetPath, transferId);
                        transferredBytes += fileTotalBytes; 
                    } finally {
                        if (downloadListener) downloadListener.remove();
                    }
                    
                    // Delete Source (Only if Move)
                    if (isMove) {
                        await client.deleteFile(itemPath);
                    }
                } else {
                    // WebDAV -> WebDAV (Cloud Copy via Local Proxy)
                    // Avoid loading into JS memory (OOM). Use Native Pipe: Remote -> Temp File -> Remote
                    console.log(`[CrossDrive] Optimizing WebDAV -> WebDAV via Temp for ${itemPath}`);
                    
                    const tempFileName = `cross_${Date.now()}_${itemName}`;
                    const tempPath = Directory.Cache; // Logical directory
                    // We need absolute path for streamUploadFile. 
                    // NativeWebDAV uses getExternalCacheDir if path doesn't exist?
                    // Let's rely on streamDownloadFile to write to Cache.
                    
                    // 1. Download to Temp (Stream)
                    // We need a path relative to ExternalStorage or absolute.
                    // NativeAPI.streamDownloadFile uses WebDavNative.download.
                    // WebDavNative.download: if path starts with root, absolute. Else relative to ExternalStorage.
                    // It doesn't support CacheDir easily via API logic in `WebDavPlugin.java`.
                    // But `WebDavPlugin.java` line 670: `File root = Environment.getExternalStorageDirectory();`.
                    // It forces ExternalStorage.
                    
                    // So we must use a temp folder in ExternalStorage (e.g. .WebDavClientTemp).
                    const tempDir = `.WebDavClientTemp`;
                    await NativeAPI.createFolder(`/${tempDir}`, 'local');
                    const localTempPath = `/${tempDir}/${tempFileName}`;
                    
                    // Determine Source Client
                    const drives = await NativeAPI.getDrives();
                    const srcConfig = drives.find(d => d.id === sourceDriveId);
                    const srcClient = getWebDAVClient(srcConfig);
                    
                    // Determine Dest Client
                    const dstConfig = drives.find(d => d.id === destDriveId);
                    const dstClient = getWebDAVClient(dstConfig);
                    
                    const cleanDest = destPath === '/' ? '' : destPath.replace(/\/+$/, '');
                    const targetPath = cleanDest + '/' + itemName;

                    // A. Download Source -> Local Temp
                    // Use existing logic for WebDAV->Local but manual
                    // Reuse transferId so cancellation works (api.cancelTask calls cancel with transferId)
                    const downloadId = transferId; 
                    
                    // Register download listener for progress
                    let lastUpdate = Date.now();
                    let lastBytes = 0;
                    let downloadListener = null;
                    
                    if (Capacitor.isNativePlatform()) {
                         downloadListener = await WebDavNative.addListener('downloadProgress', (info) => {
                             if (info.id === downloadId) {
                                 if (cancellationMap[transferId]?.cancelled) return;
                                 const { downloaded, total } = info;
                                 const now = Date.now();
                                 const timeDiff = (now - lastUpdate) / 1000;
                                 
                                 // Phase 1: Downloading (0-50% of total visual progress?)
                                 // Or just show downloading activity.
                                 // Let's map 0-50% for download, 50-100% for upload.
                                 const phaseTotal = total || 0;
                                 const visualTotal = phaseTotal * 2;
                                 
                                 let speed = 0;
                                 if (timeDiff > 0) {
                                     const bytesDiff = downloaded - lastBytes;
                                     speed = bytesDiff / timeDiff;
                                 }
                                 lastUpdate = now;
                                 lastBytes = downloaded;
                                 
                                 if (onProgress) onProgress(i + 1, items.length, `${itemName} (Downloading)`, speed, downloaded, visualTotal);
                             }
                         });
                    }
                    
                    try {
                        await srcClient.streamDownloadFile(itemPath, localTempPath, downloadId);
                    } finally {
                        if (downloadListener) downloadListener.remove();
                    }
                    
                    if (cancellationMap[transferId]?.cancelled) throw new Error("Cancelled");

                    // B. Upload Local Temp -> Dest
                    // Use existing logic for Local->WebDAV
                    const uploadId = transferId;
                    lastUpdate = Date.now();
                    lastBytes = 0;
                    
                    // Get temp file size for accurate progress
                    let tempSize = 0;
                    try {
                        const stat = await Filesystem.stat({ path: localTempPath, directory: Directory.ExternalStorage });
                        tempSize = stat.size;
                    } catch(e) {}

                    uploadCallbacks[uploadId] = (info) => {
                        if (cancellationMap[transferId]?.cancelled) return;
                        const { uploaded, total } = info;
                        const now = Date.now();
                        const timeDiff = (now - lastUpdate) / 1000;
                        
                        let speed = 0;
                        if (timeDiff > 0) {
                             const bytesDiff = uploaded - lastBytes;
                             speed = bytesDiff / timeDiff;
                        }
                        lastUpdate = now;
                        lastBytes = uploaded;
                        
                        // Phase 2: Uploading (starts at 50%)
                        const visualCurrent = tempSize + uploaded;
                        const visualTotal = tempSize * 2;

                        if (onProgress) onProgress(i + 1, items.length, `${itemName} (Uploading)`, speed, visualCurrent, visualTotal);
                    };
                    
                    try {
                        await dstClient.streamUploadFile(targetPath, localTempPath, uploadId);
                    } finally {
                        delete uploadCallbacks[uploadId];
                        // Cleanup Temp
                        try {
                            await Filesystem.deleteFile({ path: localTempPath, directory: Directory.ExternalStorage });
                        } catch(e) {}
                    }
                    
                    // 3. Delete Source (Only if Move)
                    if (isMove) {
                        await srcClient.deleteFile(itemPath);
                    }
                }
                console.log(`[CrossDrive] Transfer complete for ${itemPath}`);
                if (onItemComplete) onItemComplete(itemName); // Notify item complete
            } catch (e) {
                // If cancelled (Socket closed), ignore error
                if (taskId && cancellationMap[taskId]?.cancelled) {
                    console.log(`[CrossDrive] Task ${taskId} was cancelled during execution.`);
                    
                    // Cleanup Remote Partial File (Upload Scenarios)
                    if (destDriveId !== 'local') {
                         console.log(`[CrossDrive] Cleaning up remote file: ${targetPath}`);
                         try {
                             const drives = await NativeAPI.getDrives();
                             const config = drives.find(d => d.id === destDriveId);
                             const client = getWebDAVClient(config);
                             await client.deleteFile(targetPath);
                         } catch(cleanupErr) {
                             console.warn("[CrossDrive] Remote cleanup failed (maybe file didn't exist yet)", cleanupErr);
                         }
                    }
                    
                    // Local partial files are handled by Native `download` catch block or `uploadFiles` temp cleanup.
                    
                } else {
                    console.error(`[CrossDrive] Failed to transfer ${itemPath}:`, e);
                    throw e;
                }
            }
        }
      } finally {
          // Wait a bit to ensure all native events are flushed
          await new Promise(resolve => setTimeout(resolve, 500));

          if (Capacitor.isNativePlatform()) {
             await WebDavNative.stopBackgroundWork();
          }
          await cancelNotify(NOTIFY_ID);
      }
  },

  uploadFiles: async (path, files, driveId, onProgress, onItemComplete) => {
    const NOTIFY_ID = 9999;
    let transferredBytes = 0; // Bytes fully completed from previous files
    const startTime = Date.now();
    
    // Ensure listener is active
    if (Capacitor.isNativePlatform()) {
        await initGlobalUploadListener();
    }

    const reportFinished = (bytes) => {
        transferredBytes += bytes;
    };

    // Helper to save JS File to Temp (Chunked)
    const saveToTemp = async (file) => {
        const tempName = `temp_${Date.now()}_${Math.random().toString(36).substring(7)}_${file.name}`;
        
        // Fast Path: Use Local Server Stream (Avoids Base64 & Bridge)
        try {
            const res = await WebDavNative.getServerUrl();
            if (res && res.url) {
                // Use /cache/ prefix to write to cache directory
                const uploadUrl = `${res.url}/cache/${encodeURIComponent(tempName)}`;
                // Use fetch to upload directly (streaming)
                const response = await fetch(uploadUrl, {
                    method: 'PUT',
                    body: file
                });
                
                if (response.ok) {
                    return {
                        uri: '', 
                        path: tempName, // Plugin will find it in CacheDir by name
                        cleanup: async () => {
                            try {
                                await Filesystem.deleteFile({ path: tempName, directory: Directory.Cache });
                            } catch(e) {}
                        }
                    };
                }
                console.warn('[Native] Fast temp upload failed status:', response.status);
            }
        } catch (e) {
            console.warn('[Native] Fast temp upload failed, falling back to slow method:', e);
        }

        // Fallback: Slow Base64 Chunked Write
        const CHUNK_SIZE = 1024 * 1024 * 1; // Reduce to 1MB for stability
        let offset = 0;
        
        // Ensure clean start
        try {
            await Filesystem.deleteFile({ path: tempName, directory: Directory.Cache });
        } catch (e) {}
        
        while (offset < file.size) {
            const chunk = file.slice(offset, offset + CHUNK_SIZE);
            const reader = new FileReader();
            const base64 = await new Promise((resolve, reject) => {
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.onerror = () => reject(reader.error || new Error('Unknown FileReader Error'));
                reader.readAsDataURL(chunk);
            });
            
            if (offset === 0) {
                 await Filesystem.writeFile({
                    path: tempName,
                    data: base64,
                    directory: Directory.Cache
                });
            } else {
                await Filesystem.appendFile({
                    path: tempName,
                    data: base64,
                    directory: Directory.Cache
                });
            }
            
            offset += CHUNK_SIZE;
            
            // Critical: Yield to Event Loop to prevent UI Freeze
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        const { uri } = await Filesystem.getUri({
             path: tempName,
             directory: Directory.Cache
        });
        
        return { 
            uri, 
            path: decodeURIComponent(uri.replace('file://', '')),
            cleanup: async () => {
                try {
                    await Filesystem.deleteFile({ path: tempName, directory: Directory.Cache });
                } catch(e) {}
            }
        }; 
    };
    
    try {
        if (Capacitor.isNativePlatform()) {
             await WebDavNative.startBackgroundWork();
        }

        if (driveId !== 'local') {
            const drives = await NativeAPI.getDrives();
            const config = drives.find(d => d.id === driveId);
            const client = getWebDAVClient(config);

            // Upload sequentially
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                // Check cancellation
                const taskId = file.taskId;
                if (taskId && cancellationMap[taskId]?.cancelled) {
                    console.log(`[Upload] Task ${taskId} cancelled before start.`);
                    if (onProgress) onProgress(i + 1, files.length, file.name, 0, 0, 0); 
                    continue;
                }

                await updateNotify(NOTIFY_ID, "Uploading Files", `Uploading ${file.name}`, i, files.length);

                if (onProgress) onProgress(i + 1, files.length, file.name, 0, 0, file.size); // Start
                
                let temp = null;
                // Use taskId as uploadId if available
                const uploadId = taskId || `upload_${Date.now()}_${i}`;
                
                let lastUpdate = Date.now();
                let lastBytes = 0;

                // Register Global Callback for this upload
                console.log('[NativeWebDAV] Registering callback for:', uploadId);
                uploadCallbacks[uploadId] = (info) => {
                    if (cancellationMap[uploadId]?.cancelled) return;
                    // console.log('[NativeWebDAV] Callback executing for:', uploadId);
                    const { uploaded, total } = info;
                    const now = Date.now();
                    const timeDiff = (now - lastUpdate) / 1000;
                    
                    let speed = 0;
                    if (timeDiff > 0) {
                        const bytesDiff = uploaded - lastBytes;
                        speed = bytesDiff / timeDiff;
                    }
                    
                    // Fallback
                    if (speed === 0 && uploaded > 0) {
                        const elapsed = (Date.now() - startTime) / 1000;
                        speed = (transferredBytes + uploaded) / elapsed;
                    }

                    lastUpdate = now;
                    lastBytes = uploaded;

                    if (onProgress) onProgress(i + 1, files.length, file.name, speed, uploaded, total);
                };

                try {
                    // Save to temp first
                    temp = await saveToTemp(file);
                    
                    // Stream Upload
                    const remotePath = `${path}/${file.name}`.replace('//', '/');
                    await client.streamUploadFile(remotePath, temp.path, uploadId);
                    
                    reportFinished(file.size);
                    if (onItemComplete) onItemComplete(file.name); // Notify item complete
                } catch (e) {
                    if (taskId && cancellationMap[taskId]?.cancelled) {
                        console.log(`[Upload] Task ${taskId} cancelled during execution.`);
                        
                        // Cleanup Remote Partial File
                        if (driveId !== 'local') {
                             console.log(`[Upload] Cleaning up remote file: ${remotePath}`);
                             try {
                                 await client.deleteFile(remotePath);
                             } catch(cleanupErr) {}
                        }
                        
                    } else {
                        console.error("Upload failed", e);
                        throw e; 
                    }
                } finally {
                    // Wait longer to ensure all native events are flushed
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    delete uploadCallbacks[uploadId];
                    if (temp) await temp.cleanup();
                }
            }
        } else {
            // Local Upload (Chunked)
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                await updateNotify(NOTIFY_ID, "Uploading Files", `Saving ${file.name}`, i, files.length);
                
                if (onProgress) onProgress(i + 1, files.length, file.name, 0, 0, file.size);
                const destPath = (path === '/' ? '' : path) + '/' + file.name;
                
                const CHUNK_SIZE = 1024 * 1024 * 1; // 1MB for stability
                let offset = 0;
                let lastUpdate = Date.now();
                let lastBytes = 0;
                
                try {
                    while (offset < file.size) {
                        const chunk = file.slice(offset, offset + CHUNK_SIZE);
                        const reader = new FileReader();
                        const base64 = await new Promise((resolve, reject) => {
                            reader.onload = () => resolve(reader.result.split(',')[1]);
                            reader.onerror = () => reject(reader.error || new Error('Unknown FileReader Error'));
                            reader.readAsDataURL(chunk);
                        });
                        
                        if (offset === 0) {
                            await Filesystem.writeFile({
                                path: destPath,
                                data: base64,
                                directory: Directory.ExternalStorage,
                                recursive: true
                            });
                        } else {
                            await Filesystem.appendFile({
                                path: destPath,
                                data: base64,
                                directory: Directory.ExternalStorage
                            });
                        }
                        offset += CHUNK_SIZE;
                        await new Promise(resolve => setTimeout(resolve, 10)); // Yield more aggressively (10ms)
                        
                        // Report Progress Locally
                        const now = Date.now();
                        const timeDiff = (now - lastUpdate) / 1000;
                        const currentUploaded = Math.min(offset, file.size);
                        
                        let speed = 0;
                        if (timeDiff > 0) {
                            const bytesDiff = currentUploaded - lastBytes;
                            speed = bytesDiff / timeDiff;
                        }
                         // Fallback
                        if (speed === 0 && currentUploaded > 0) {
                            const elapsed = (Date.now() - startTime) / 1000;
                            speed = (transferredBytes + currentUploaded) / elapsed;
                        }

                        lastUpdate = now;
                        lastBytes = currentUploaded;

                        if (onProgress) onProgress(i + 1, files.length, file.name, speed, currentUploaded, file.size);
                    }
                    reportFinished(file.size);
                    if (onItemComplete) onItemComplete(file.name); // Notify item complete
                } catch (e) {
                    console.error("Local upload failed", e);
                    throw e;
                }
            }
        }
    } finally {
        // No need to remove global listener
        if (Capacitor.isNativePlatform()) {
             await WebDavNative.stopBackgroundWork();
        }
        await cancelNotify(NOTIFY_ID);
    }
  },

  getDrives: async () => {
    // Persist drives in Capacitor Preferences instead of JSON file
    const { value } = await Preferences.get({ key: 'drives' });
    let drives = value ? JSON.parse(value) : [];
    
    // Always ensure Local is there
    if (!drives.find(d => d.id === 'local')) {
      drives.unshift({ id: 'local', name: 'On My Phone', type: 'local', path: '/' });
    }

    // Fetch Quota for WebDAV drives in parallel
    const drivesWithQuota = await Promise.all(drives.map(async (drive) => {
        if (drive.type === 'local') {
            try {
                const info = await WebDavNative.getStorageInfo();
                return { ...drive, quota: { used: info.used, total: info.total } };
            } catch (e) {
                console.warn('[Native] Failed to get storage info:', e);
                return drive;
            }
        }
        
        // WebDAV
        try {
            const client = getWebDAVClient(drive);
            // Timeout promise 2s
            const quota = await Promise.race([
                client.getQuota(),
                new Promise(resolve => setTimeout(() => resolve(null), 2000))
            ]);
            
            if (quota) {
                return { ...drive, quota: { used: quota.used, total: quota.total } };
            }
        } catch (e) {
            // Ignore quota errors
        }
        return drive;
    }));

    return drivesWithQuota;
  },

  addDrive: async (drive) => {
    const drives = await NativeAPI.getDrives();
    // Encrypt password before storage
    const encryptedPassword = encrypt(drive.password);
    const newDrive = { ...drive, password: encryptedPassword, id: crypto.randomUUID() };
    drives.push(newDrive);
    await Preferences.set({ key: 'drives', value: JSON.stringify(drives) });
    return newDrive;
  },

  updateDrive: async (id, data) => {
    let drives = await NativeAPI.getDrives();
    const index = drives.findIndex(d => d.id === id);
    if (index !== -1) {
      drives[index] = { ...drives[index], ...data };
      await Preferences.set({ key: 'drives', value: JSON.stringify(drives) });
    }
  },

  testConnection: async (config) => {
      console.log('[WebDAV] Testing connection...');
      try {
          const client = getWebDAVClient(config);
          const items = await client.getDirectoryContents('/'); 
          console.log(`[WebDAV] Success! Found ${items.length} items in root.`);
      } catch (err) {
          console.error('[WebDAV] Test Failed:', err);
          // Log object details for debugging
          if (err.response) console.error('[WebDAV] Response:', err.response);
          throw err;
      }
  },

  removeDrive: async (id) => {
    let drives = await NativeAPI.getDrives();
    drives = drives.filter(d => d.id !== id);
    await Preferences.set({ key: 'drives', value: JSON.stringify(drives) });
  },

  getFileUrl: async (path, driveId) => {
      // Returns a Promise resolving to a src string (Data URI or Native URL)
      if (driveId !== 'local') {
          try {
            const drives = await NativeAPI.getDrives();
            const config = drives.find(d => d.id === driveId);
            const client = getWebDAVClient(config);
            // Get file link (download link) usually requires auth.
            // Better to download content and convert to blob URL
            const buffer = await client.getFileContents(path, { format: 'binary' });
            const blob = base64ToBlob(buffer);
            return URL.createObjectURL(blob);
          } catch (e) { return ''; }
      }
      
      // Android Local Video Seeking Fix: Use Custom Local Server
      if (Capacitor.getPlatform() === 'android') {
          try {
              if (!cachedServerUrl) {
                  const res = await WebDavNative.getServerUrl();
                  if (res && res.url) cachedServerUrl = res.url;
              }
              if (cachedServerUrl) {
                  // Path must be URL encoded for the server to decode
                  // Ensure path starts with /
                  const cleanPath = path.startsWith('/') ? path : '/' + path;
                  return `${cachedServerUrl}${encodeURI(cleanPath)}`;
              }
          } catch (e) {
              console.warn('[Native] Failed to get local server URL:', e);
          }
      }

      try {
          const { uri } = await Filesystem.getUri({
              path: path,
              directory: Directory.ExternalStorage
          });
          return Capacitor.convertFileSrc(uri);
      } catch (e) { 
          console.error('[Native] getFileUrl failed', e);
          return ''; 
      }
  },

  getThumbnailUrl: async (path, driveId) => {
      // Optimization: Disable remote thumbnails to prevent OOM
      // Downloading full files for list thumbnails is too heavy for memory
      if (driveId !== 'local') return null;

      // For now, fallback to full file URL (Native rendering)
      return NativeAPI.getFileUrl(path, driveId);
  },

  getFileBlob: async (path, driveId) => {
      if (driveId !== 'local') {
          const drives = await NativeAPI.getDrives();
          const config = drives.find(d => d.id === driveId);
          const client = getWebDAVClient(config);
          const buffer = await client.getFileContents(path, { format: 'binary' });
          return base64ToBlob(buffer);
      }
      const file = await Filesystem.readFile({
          path: path,
          directory: Directory.ExternalStorage
      });
      return base64ToBlob(file.data);
  },

  readFileText: async (path, driveId) => {
      if (driveId !== 'local') {
          const drives = await NativeAPI.getDrives();
          const config = drives.find(d => d.id === driveId);
          const client = getWebDAVClient(config);
          const text = await client.getFileContents(path, { format: 'text' });
          return text;
      }
      const file = await Filesystem.readFile({
          path: path,
          directory: Directory.ExternalStorage,
          encoding: Encoding.UTF8
      });
      return file.data;
  },

  searchItems: async (query, driveId, rootPath = '/') => {
    if (driveId !== 'local') {
        return []; // WebDAV search not supported on mobile
    }
    try {
        const res = await WebDavNative.search({ query });
        return res.items.map(item => ({
            name: item.name,
            path: item.path,
            isDirectory: item.isDirectory,
            size: item.size,
            mtime: item.mtime,
            type: item.isDirectory ? 'folder' : 'application/octet-stream'
        }));
    } catch (e) {
        console.warn('[Native] Search failed:', e);
        return [];
    }
  },

  cancelTask: async (taskId) => {
      console.log(`[API] Cancelling task: ${taskId}`);
      cancellationMap[taskId] = { cancelled: true };
      
      if (Capacitor.isNativePlatform()) {
          // Attempt to cancel native call if it matches taskId (we used taskId as native ID)
          try {
              await WebDavNative.cancel({ id: taskId });
          } catch(e) {
              console.warn('[Native] Cancel failed:', e);
          }
      }
  },

  requestPermissions: async () => {
    try {
        await Filesystem.requestPermissions();
        if (Capacitor.getPlatform() === 'android') {
            await WebDavNative.requestManageStoragePermission();
            await WebDavNative.requestNotificationPermission();
        }
    } catch (e) {
        console.warn('[Native] Failed to request permissions:', e);
    }
  }
};

// --- Export Unified API ---
const isNative = Capacitor.isNativePlatform();
const api = isNative ? NativeAPI : ServerAPI;

export default api;