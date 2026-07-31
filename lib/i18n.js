// Chargeur i18n partagé (CLI + serveur). Les traductions vivent dans des
// fichiers JSON sous i18n/<lang>.json — data-only, aucune modification de
// code nécessaire pour ajouter une langue : dépose i18n/<code>.json avec les
// mêmes clés et elle apparaît automatiquement (ici et dans l'interface web,
// qui charge les mêmes fichiers).
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'i18n');
const DEFAULT_LANG = 'fr';

let _available = null;
function available() {
  if (!_available) {
    _available = fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  }
  return _available;
}

const _cache = {};
function dict(lang) {
  const resolved = available().includes(lang) ? lang : DEFAULT_LANG;
  if (!_cache[resolved]) {
    _cache[resolved] = JSON.parse(fs.readFileSync(path.join(DIR, `${resolved}.json`), 'utf8'));
  }
  return _cache[resolved];
}

function t(lang, key, vars = {}) {
  const str = dict(lang)[key] ?? dict(DEFAULT_LANG)[key] ?? key;
  return str.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

module.exports = { t, available, DEFAULT_LANG };
