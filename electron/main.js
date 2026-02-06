const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const waitOn = require('wait-on');
const fs = require('fs');
const net = require('net');

let mainWindow;
let serverProcess;
let serverPort = 8000; // Default, will be updated

// Setup Logging
const LOG_PATH = path.join(app.getPath('userData'), 'app.log');
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

function log(msg) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] [Main] ${msg}\n`;
  console.log(msg);
  logStream.write(message);
}

// ... (getPort and getLogContent functions remain the same)

// IPC: Handle Native Drag Start
ipcMain.on('ondragstart', async (event, files, driveId) => {
    log(`[IPC] ondragstart: ${files.length} items from ${driveId}`);
    
    const iconPath = path.join(__dirname, '../client/assets/icon.png');
    
    // Strategy 1: Instant Local Drag
    if (driveId === 'local') {
        try {
            // Local storage root
            const storageDir = require('os').homedir();
            
            const absFiles = files.map(f => {
                // Remove leading slashes and resolve against Home
                const rel = f.replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
                return path.join(storageDir, rel);
            }).filter(p => fs.existsSync(p));

            if (absFiles.length > 0) {
                log(`[Drag] Starting LOCAL drag for ${absFiles.length} files`);
                
                const dragOptions = {
                    file: absFiles[0],
                    files: absFiles
                };
                if (fs.existsSync(iconPath)) {
                    dragOptions.icon = iconPath;
                }

                event.sender.startDrag(dragOptions);
            }
        } catch (e) {
            log(`[Drag] Local resolution failed: ${e.message}`);
        }
        return;
    }

    // Strategy 2: Remote/WebDAV Drag (Async Download)
    try {
        const response = await fetch(`http://127.0.0.1:${serverPort}/api/prepare-drag`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: files, drive: driveId })
        });

        if (response.ok) {
            const result = await response.json();
            if (result.files && result.files.length > 0) {
                log(`[Drag] Starting REMOTE drag for: ${JSON.stringify(result.files)}`);
                
                const dragOptions = {
                    file: result.files[0],
                    files: result.files
                };
                if (fs.existsSync(iconPath)) {
                    dragOptions.icon = iconPath;
                } else {
                    log(`[Drag] Warning: Icon not found at ${iconPath}`);
                }

                event.sender.startDrag(dragOptions);
            }
        } else {
            log(`[Drag] Server returned ${response.status}`);
        }
    } catch (e) {
        log(`[Drag] Request failed: ${e.message}`);
    }
});

// Helper to find a free port
function getPort(startPort) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(startPort, '127.0.0.1', () => {
            server.close(() => resolve(startPort));
        });
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve(getPort(startPort + 1));
            } else {
                reject(err);
            }
        });
    });
}

function getLogContent() {
    try {
        if (fs.existsSync(LOG_PATH)) {
            const stats = fs.statSync(LOG_PATH);
            const size = stats.size;
            const bufferSize = Math.min(10000, size); // Read last 10KB
            const buffer = Buffer.alloc(bufferSize);
            const fd = fs.openSync(LOG_PATH, 'r');
            fs.readSync(fd, buffer, 0, bufferSize, size - bufferSize);
            fs.closeSync(fd);
            return buffer.toString('utf8');
        }
        return 'Log file not found.';
    } catch (e) {
        return `Error reading log: ${e.message}`;
    }
}

async function startServer() {
  const serverPath = path.join(__dirname, '../server/index.js');
  log(`Starting server from: ${serverPath}`);
  
  if (!fs.existsSync(serverPath)) {
      log('CRITICAL: Server file not found!');
      return;
  }

  // Find a free port
  try {
      serverPort = await getPort(8000);
      log(`Found free port: ${serverPort}`);
  } catch (err) {
      log(`Failed to find free port: ${err.message}`);
      serverPort = 8000; // Fallback
  }

  // Start the server as a child process
  serverProcess = fork(serverPath, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { 
      ...process.env, 
      NODE_ENV: 'production',
      USER_DATA_PATH: app.getPath('userData'),
      ELECTRON_LOG_PATH: LOG_PATH,
      PORT: serverPort.toString()
    }
  });

  serverProcess.stdout.on('data', (data) => {
    const msg = `[Server] ${data.toString()}`;
    console.log(msg.trim());
    logStream.write(msg);
  });

  serverProcess.stderr.on('data', (data) => {
    const msg = `[Server ERR] ${data.toString()}`;
    console.error(msg.trim());
    logStream.write(msg);
  });

  serverProcess.on('error', (err) => {
      log(`Server failed to start: ${err.message}`);
  });
  
  serverProcess.on('exit', (code, signal) => {
      log(`Server exited with code ${code} and signal ${signal}`);
  });

  log(`Server started with PID: ${serverProcess.pid}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: true, // Enable DevTools
      preload: path.join(__dirname, 'preload.js') // Register Preload
    },
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 10, y: 10 }, 
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../client/assets/icon.png')
  });

  // Use 127.0.0.1 for reliability
  const url = `http://127.0.0.1:${serverPort}`;

  // Wait for server to be ready before loading URL
  log(`Waiting for ${url}...`);
  waitOn({ resources: [url], timeout: 20000, interval: 500 })
    .then(() => {
      log('Server is ready, loading window...');
      mainWindow.loadURL(url).catch(e => log(`Failed to load URL: ${e.message}`));
    })
    .catch((err) => {
      log(`Server timeout or error: ${err}`);
      
      const logContent = getLogContent().replace(/\n/g, '<br/>');
      
      // Load error page
      const errorHtml = `
        <html>
        <body style="font-family: sans-serif; padding: 2rem; text-align: center;">
          <h1 style="color: #ef4444;">Application Failed to Start</h1>
          <p>The internal server could not be reached.</p>
          <p>Please check if port ${serverPort} is available or blocked by firewall.</p>
          <p style="background: #f1f5f9; padding: 1rem; border-radius: 8px; text-align: left; font-family: monospace; max-height: 400px; overflow-y: auto;">
            <strong>Error:</strong> ${err.message}<br/><br/>
            <strong>Log (${LOG_PATH}):</strong><br/>
            <div style="white-space: pre-wrap; font-size: 10px;">${logContent}</div>
          </p>
          <button onclick="location.reload()" style="padding: 10px 20px; cursor: pointer;">Retry</button>
        </body>
        </html>
      `;
      mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorHtml));
    });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.on('ready', async () => {
  await startServer();
  createWindow();
});

// Quit when all windows are closed.
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
  if (mainWindow === null) createWindow();
});

// Cleanup server process on exit
app.on('before-quit', () => {
  if (serverProcess) {
    console.log('[Electron] Killing server process...');
    serverProcess.kill();
  }
});
