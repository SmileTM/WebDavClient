import axios from 'axios';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { createClient } from 'webdav';
import { Buffer } from 'buffer';
import { encrypt, decrypt } from '../utils/clientCrypto';

// --- Native Plugin Interface ---
const WebDavNative = registerPlugin('WebDavNative');

// --- Critical Polyfill for Mobile ---
// Ensure Buffer is available globally
if (typeof window !== 'undefined') {
    window.Buffer = window.Buffer || Buffer;
    window.global = window.global || window; 
}

// --- Custom Native WebDAV Client (Bypasses CORS & CapacitorHttp) ---
class NativeWebDAVClient {
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

    async putFileContents(path, content) {
        // content is expected to be Base64 string if it's binary data
        await this._request('PUT', path, {
             data: content,
             headers: { 'Content-Type': 'application/octet-stream' },
             bodyIsBase64: true // Tell native plugin to decode
        });
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
            responseType: options.responseType || 'text'
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
    
    async putFileContents(path, content) {
        await this._request('PUT', path, {
             data: content.toString(),
             headers: { 'Content-Type': 'application/octet-stream' },
             bodyIsBase64: true 
        });
    }

    async getFileContents(path, options = {}) {
        const res = await this._request('GET', path, {
            ...options,
            responseType: options.format === 'binary' ? 'base64' : 'text'
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
  crossDriveTransfer: async (items, sourceDriveId, destPath, destDriveId, isMove = false, onProgress) => {
      for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const fileName = item.split('/').pop();
          if (onProgress) onProgress(i + 1, items.length, fileName);
          await axios.post('/api/transfer', {
              items: [item],
              sourceDrive: sourceDriveId,
              destDrive: destDriveId,
              destPath: destPath,
              move: isMove
          });
      }
  },
  uploadFiles: async (path, files, driveId) => {
    const formData = new FormData();
    files.forEach(f => formData.append('files', f));
    await axios.post(`/api/upload?path=${encodeURIComponent(path)}&drive=${driveId}`, formData, { 
      headers: { 'Content-Type': 'multipart/form-data' } 
    });
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
           mtime: item.lastmod,
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

  crossDriveTransfer: async (items, sourceDriveId, destPath, destDriveId, isMove = false, onProgress) => {
      console.log(`[CrossDrive] Transferring ${items.length} items from ${sourceDriveId} to ${destDriveId} (Move: ${isMove})`);
      
      let transferredBytes = 0;
      const startTime = Date.now();

      // ... (readContent and writeContent helpers remain same) ...
      // Helper to read content
      const readContent = async (path, driveId) => {
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
              const base64Data = await client.getFileContents(path, { format: 'binary' });
              return base64Data;
          }
      };

      // Helper to write content
      const writeContent = async (path, content, driveId) => {
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
              await client.putFileContents(targetPath, content);
          }
      };

      // Execution Loop
      for (let i = 0; i < items.length; i++) {
          const itemPath = items[i];
          const itemName = itemPath.split('/').pop();
          // Report start of item (speed keeps previous value or 0)
          const currentSpeed = (transferredBytes > 0 && (Date.now() - startTime) > 0) 
              ? transferredBytes / ((Date.now() - startTime) / 1000) 
              : 0;
          if (onProgress) onProgress(i + 1, items.length, itemName, currentSpeed);

          try {
              console.log(`[CrossDrive] 1. Reading ${itemPath}`);
              // 1. Read
              const content = await readContent(itemPath, sourceDriveId);
              
              // 2. Write
              console.log(`[CrossDrive] 2. Writing to ${destDriveId}`);
              await writeContent(itemPath, content, destDriveId);
              
              // Update stats (content is Base64, size is approx * 0.75)
              transferredBytes += Math.round(content.length * 0.75);
              
              // 3. Delete Source (Only if Move)
              if (isMove) {
                  console.log(`[CrossDrive] 3. Deleting source ${itemPath}`);
                  if (sourceDriveId === 'local') {
                      await Filesystem.deleteFile({ path: itemPath, directory: Directory.ExternalStorage });
                  } else {
                      const drives = await NativeAPI.getDrives();
                      const config = drives.find(d => d.id === sourceDriveId);
                      const client = getWebDAVClient(config);
                      await client.deleteFile(itemPath);
                  }
              }
              console.log(`[CrossDrive] Transfer complete for ${itemPath}`);
          } catch (e) {
              console.error(`[CrossDrive] Failed to transfer ${itemPath}:`, e);
              throw e;
          }
      }
  },

  uploadFiles: async (path, files, driveId, onProgress) => {
    let transferredBytes = 0;
    const startTime = Date.now();

    const reportProgress = (index, filename, bytes) => {
        if (!onProgress) return;
        transferredBytes += bytes;
        const elapsed = (Date.now() - startTime) / 1000; // seconds
        const speed = elapsed > 0 ? transferredBytes / elapsed : 0; // bytes/s
        onProgress(index, files.length, filename, speed);
    };

    // Handling File Objects in Native is tricky. 
    // Usually involves reading file into base64 and writing.
    if (driveId !== 'local') {
        const drives = await NativeAPI.getDrives();
        const config = drives.find(d => d.id === driveId);
        const client = getWebDAVClient(config);

        await Promise.all(files.map(async (file, index) => {
            if (onProgress) onProgress(index + 1, files.length, file.name, 0); // Start
            const arrayBuffer = await file.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const remotePath = `${path}/${file.name}`.replace('//', '/');
            await client.putFileContents(remotePath, buffer);
            reportProgress(index + 1, file.name, file.size);
        }));
        return;
    }

    // Local Upload
    await Promise.all(files.map(async (file, index) => {
       if (onProgress) onProgress(index + 1, files.length, file.name, 0);
       const destPath = (path === '/' ? '' : path) + '/' + file.name;
       
       // Convert File to Base64
       const toBase64 = (file) => new Promise((resolve, reject) => {
           const reader = new FileReader();
           reader.readAsDataURL(file);
           reader.onload = () => resolve(reader.result.split(',')[1]); // Remove data:mime;base64,
           reader.onerror = error => reject(error);
       });

       const data = await toBase64(file);
       
       await Filesystem.writeFile({
           path: destPath,
           data: data,
           directory: Directory.ExternalStorage,
           recursive: true 
       });
       reportProgress(index + 1, file.name, file.size);
    }));
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
            const blob = new Blob([buffer]);
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
      // For now, fallback to full file URL (Native rendering)
      return NativeAPI.getFileUrl(path, driveId);
  },

  getFileBlob: async (path, driveId) => {
      if (driveId !== 'local') {
          const drives = await NativeAPI.getDrives();
          const config = drives.find(d => d.id === driveId);
          const client = getWebDAVClient(config);
          const buffer = await client.getFileContents(path, { format: 'binary' });
          return new Blob([buffer]);
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

  requestPermissions: async () => {
    try {
        await Filesystem.requestPermissions();
        if (Capacitor.getPlatform() === 'android') {
            await WebDavNative.requestManageStoragePermission();
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