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
    CREATE INDEX IF NOT EXISTS idx_friends_decision ON friends(decision);
    CREATE INDEX IF NOT EXISTS idx_friends_applied_at ON friends(applied_at);
    CREATE INDEX IF NOT EXISTS idx_friends_presence_since ON friends(presence_since);
    CREATE INDEX IF NOT EXISTS idx_friends_presence_status ON friends(presence_status);

    -- Historique des changements de statut de présence (offline/online/...),
    -- un peu comme le journal ami de VRCX. Une ligne par transition
    -- constatée d'un import à l'autre — la granularité dépend donc de la
    -- fréquence des rafraîchissements (manuels ou auto), pas d'un suivi
    -- temps réel.
    CREATE TABLE IF NOT EXISTS presence_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      friend_id TEXT NOT NULL,
      status TEXT,
      changed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_presence_log_friend ON presence_log(friend_id, changed_at);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const columns = _db.prepare(`PRAGMA table_info(friends);`).all().map((c) => c.name);
  if (!columns.includes('notes')) {
    _db.exec(`ALTER TABLE friends ADD COLUMN notes TEXT;`);
  }
  if (!columns.includes('org_name')) {
    _db.exec(`
      ALTER TABLE friends ADD COLUMN org_name TEXT;
      ALTER TABLE friends ADD COLUMN org_url TEXT;
      ALTER TABLE friends ADD COLUMN org_redacted INTEGER DEFAULT 0;
    `);
  }

  return _db;
}

function getSetting(key, defaultValue) {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key=?;`).get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  getDb()
    .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`)
    .run(key, value);
}

module.exports = { getDb, getSetting, setSetting };
