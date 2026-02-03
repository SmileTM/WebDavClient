const { app, BrowserWindow } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const waitOn = require('wait-on');

let mainWindow;
let serverProcess;

const SERVER_PORT = 8000; // Must match server/index.js

function startServer() {
  const serverPath = path.join(__dirname, '../server/index.js');
  
  // Start the server as a child process
  serverProcess = fork(serverPath, [], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' }
  });

  console.log(`[Electron] Server started with PID: ${serverProcess.pid}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 24, y: 24 }, // Position inside the floating sidebar
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../client/assets/icon.png')
  });

  const url = `http://localhost:${SERVER_PORT}`;

  // Wait for server to be ready before loading URL
  waitOn({ resources: [url], timeout: 10000 })
    .then(() => {
      console.log('[Electron] Server is ready, loading window...');
      mainWindow.loadURL(url);
    })
    .catch((err) => {
      console.error('[Electron] Server timeout:', err);
      // Fallback or error handling
    });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.on('ready', () => {
  startServer();
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
