// Point d'entrée Electron : héberge le même serveur local (server.js) dans
// le process principal, et ouvre une fenêtre dessus. Les données (auth.json,
// friends.json, friends.db) vivent dans le dossier userData du système —
// le seul emplacement garanti inscriptible pour une appli installée (ex:
// Program Files sur Windows est en lecture seule pour l'utilisateur courant).
const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');

const PORT = 3939;
const APP_ORIGIN = `http://127.0.0.1:${PORT}`;

// Empêche deux instances de l'appli de tourner en même temps (un double-clic
// accidentel, ou l'appli déjà ouverte en arrière-plan) : la deuxième
// tentative se contente de rendre le focus à la fenêtre existante au lieu
// d'essayer de démarrer un second serveur sur le même port (ce qui plantait
// avec "127.0.0.1:3939 already in use").
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

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
    // En dessous, le tableau/toolbar tronque ou superpose ses éléments.
    minWidth: 1050,
    minHeight: 650,
    title: 'sc-friends',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      // Valeurs par défaut d'Electron moderne, posées explicitement : pas
      // d'accès Node.js depuis la page web, pas de désactivation du sandbox
      // de rendu. On ne charge que notre propre serveur local, mais autant
      // ne pas dépendre des défauts si une future version d'Electron change.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Liens externes (GitHub, parrainage RSI...) : ouverts dans le vrai
  // navigateur système, jamais dans une fenêtre Electron supplémentaire.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Empêche la fenêtre principale de naviguer ailleurs que vers notre propre
  // serveur local (au cas où un contenu injecté tenterait de rediriger la
  // page vers un site distant).
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.loadURL(APP_ORIGIN);
}

if (gotLock) {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

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
}
