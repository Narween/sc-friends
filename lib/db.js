// Accès SQLite partagé (better-sqlite3, embarquable dans Electron — plus
// besoin du binaire CLI `sqlite3` séparé). Toutes les requêtes utilisent des
// paramètres liés (`?`), pas de concaténation de chaînes.
const Database = require('better-sqlite3');
const { DB_FILE } = require('./paths');

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new Database(DB_FILE);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS friends (
      id TEXT PRIMARY KEY,
      nickname TEXT,
      displayname TEXT,
      avatar TEXT,
      presence_status TEXT,
      presence_since INTEGER,
      common_communities_count INTEGER,
      raw_json TEXT,
      decision TEXT,
      decided_at TEXT,
      applied_at TEXT,
      apply_success INTEGER,
      apply_response TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return _db;
}

module.exports = { getDb };
