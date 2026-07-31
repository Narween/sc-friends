// Point d'entrée Electron : héberge le même serveur local (server.js) dans
// le process principal, et ouvre une fenêtre dessus. Les données (auth.json,
// friends.json, friends.db) vivent dans le dossier userData du système —
// le seul emplacement garanti inscriptible pour une appli installée (ex:
// Program Files sur Windows est en lecture seule pour l'utilisateur courant).
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const PORT = 3939;

function resolveBrowsersPath() {
  // Playwright a été installé avec PLAYWRIGHT_BROWSERS_PATH=0 (voir
  // package.json / CI) : les navigateurs vivent dans
  // node_modules/playwright-core/.local-browsers, un chemin relatif stable
  // qu'electron-builder embarque avec le reste de node_modules. On force la
  // même valeur au runtime pour que Playwright les retrouve une fois
  // packagé, sans tenter un téléchargement.
  process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 1000,
    title: 'sc-friends',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
  });
  win.loadURL(`http://127.0.0.1:${PORT}`);
}

app.whenReady().then(() => {
  process.env.SC_FRIENDS_DATA_DIR = app.getPath('userData');
  process.env.PORT = String(PORT);
  resolveBrowsersPath();

  // Démarre le serveur local dans ce même process (effet de bord : écoute
  // sur 127.0.0.1:PORT dès le require).
  require('../server.js');

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
