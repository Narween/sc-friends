// Centralise les chemins de données. En usage CLI normal, tout vit dans le
// répertoire courant (comportement historique). Quand l'appli tourne
// packagée dans Electron, main.js positionne SC_FRIENDS_DATA_DIR vers le
// dossier userData du système (seul endroit garanti inscriptible), et tous
// les scripts s'y adaptent sans changement de logique.
const path = require('node:path');

const DATA_DIR = process.env.SC_FRIENDS_DATA_DIR || process.cwd();

module.exports = {
  DATA_DIR,
  AUTH_FILE: path.join(DATA_DIR, 'auth.json'),
  FRIENDS_JSON_FILE: path.join(DATA_DIR, 'friends.json'),
  DB_FILE: path.join(DATA_DIR, 'friends.db'),
  LOGIN_SIGNAL_FILE: path.join(DATA_DIR, '.login-done.signal'),
};
