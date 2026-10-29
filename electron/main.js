// Point d'entrée Electron : héberge le même serveur local (server.js) dans
// le process principal, et ouvre une fenêtre dessus. Les données (auth.json,
// friends.json, friends.db) vivent dans le dossier userData du système —
// le seul emplacement garanti inscriptible pour une appli installée (ex:
// Program Files sur Windows est en lecture seule pour l'utilisateur courant).
const { app, BrowserWindow, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');

const PORT = 3939;
const APP_ORIGIN = `http://127.0.0.1:${PORT}`;
const PKG_VERSION = require('../package.json').version;

// Filet de sécurité : sans ça, une exception non attrapée dans le process
// principal fait apparaître la boîte de dialogue de crash générique
// d'Electron/Chromium (illisible, non traduite). On log dans stderr et on
// tente de garder l'appli ouverte plutôt que de la laisser planter dans le
// vide sans explication.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  if (app.isReady()) {
    dialog.showErrorBox('SC-Friends — erreur inattendue / unexpected error', String(err?.stack || err));
  }
});

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
  if (!app.isPackaged) {
    // Hors paquet (dev) : pas d'asar du tout, la valeur spéciale "0" suffit
    // (Playwright a été installé avec PLAYWRIGHT_BROWSERS_PATH=0, voir
    // package.json / CI, donc les navigateurs vivent déjà dans
    // node_modules/playwright-core/.local-browsers).
    process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
    return;
  }
  // Packagé : on a vu Playwright échouer à retrouver Chromium même avec
  // node_modules/playwright(-core) sorti de l'asar (asarUnpack) — la
  // redirection transparente asar->asar.unpacked d'Electron n'est
  // apparemment pas fiable à 100% pour ce cas d'usage (spawn d'un vrai
  // exécutable, pas juste une lecture de fichier). On calcule donc le
  // chemin réel nous-mêmes via process.resourcesPath, qui pointe toujours
  // sur le vrai disque, sans jamais passer par un chemin "virtuel" *.asar.
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    'playwright-core',
    '.local-browsers'
  );
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 1000,
    // En dessous, le tableau/toolbar tronque ou superpose ses éléments.
    minWidth: 1050,
    minHeight: 650,
    title: `SC-Friends v${PKG_VERSION}`,
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

// Auto-update via electron-updater, branché sur les GitHub Releases déjà
// publiées par le workflow de build (latest.yml / latest-linux.yml généré
// par electron-builder à côté des installeurs). Windows (NSIS) et Linux
// (AppImage) fonctionnent très bien sans certificat de signature de code.
// macOS est volontairement exclu : Squirrel.Mac (le mécanisme d'update
// d'Electron sur macOS) exige une app signée, et une app non signée y
// échoue silencieusement ou lève une erreur de vérification de signature —
// sur Mac, on se contente de prévenir qu'une nouvelle version existe et
// d'ouvrir la page de la Release (voir checkForUpdatesMac).
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RELEASES_API = 'https://api.github.com/repos/Narween/sc-friends/releases/latest';

// "1.0.14" > "1.0.9" : comparaison numérique champ par champ, un éventuel
// "v" de tête (nom de tag) ignoré.
function isNewer(remote, local) {
  const a = remote.replace(/^v/, '').split('.').map(Number);
  const b = local.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

// Version déjà signalée pendant cette session : sans ça, la vérification
// toutes les 6 h reposerait la même question à chaque fois.
let macNotifiedVersion = null;

async function checkForUpdatesMac() {
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return;
    const rel = await res.json();
    if (!rel.tag_name || rel.draft || rel.prerelease) return;
    if (!isNewer(rel.tag_name, app.getVersion()) || macNotifiedVersion === rel.tag_name) return;
    macNotifiedVersion = rel.tag_name;
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Télécharger / Download', 'Plus tard / Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'SC-Friends',
      message: `Nouvelle version disponible : ${rel.tag_name}\nNew version available: ${rel.tag_name}`,
      detail: `Version installée / installed: ${app.getVersion()}`,
    });
    if (response === 0) shell.openExternal(rel.html_url);
  } catch (err) {
    console.error('update check (mac) error:', err);
  }
}

function checkForUpdates() {
  if (!app.isPackaged) return;
  if (process.platform === 'darwin') {
    checkForUpdatesMac();
    return;
  }
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('autoUpdater error:', err);
  });
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
    // Packagé : __dirname (utilisé plus bas comme cwd des scripts enfants)
    // pointe dans app.asar, un chemin virtuel que CreateProcess ne sait pas
    // résoudre côté Windows (ENOENT trompeur, qui nomme l'exécutable alors
    // que c'est le cwd le vrai coupable). process.resourcesPath pointe
    // toujours sur un vrai dossier disque, quel que soit l'OS.
    if (app.isPackaged) {
      process.env.SC_FRIENDS_RESOURCES_PATH = process.resourcesPath;
    }
    resolveBrowsersPath();

    // Démarre le serveur local dans ce même process (effet de bord : écoute
    // sur 127.0.0.1:PORT dès le require).
    require('../server.js');

    createWindow();
    checkForUpdates();
    // Appli souvent laissée ouverte longtemps : on revérifie régulièrement,
    // pas seulement au démarrage.
    setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
