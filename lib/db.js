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

    -- Historique des changements observés (statut de présence, pseudo, nom
    -- affiché...), un peu comme le journal ami de VRCX. Une ligne par
    -- transition constatée d'un import à l'autre — la granularité dépend
    -- donc de la fréquence des rafraîchissements (manuels ou auto), pas d'un
    -- suivi temps réel. "field" distingue le type de changement
    -- ('presence' / 'nickname' / 'displayname'), "value" est la nouvelle
    -- valeur observée. Sert à la fois au popup d'historique par ami et au
    -- flux d'activité global (mêmes lignes, deux vues différentes).
    CREATE TABLE IF NOT EXISTS change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      friend_id TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT,
      changed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_change_log_friend ON change_log(friend_id, changed_at);
    CREATE INDEX IF NOT EXISTS idx_change_log_changed_at ON change_log(changed_at);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Orgs affiliées (secondaires), remplies par fetch-profiles.js depuis la
    -- page publique RSI /citizens/<pseudo>/organizations — absentes de
    -- l'API interne Spectrum, donc d'une source différente de org_name/
    -- org_url sur "friends" (qui viennent eux de meta.badges). Une ligne
    -- par affiliation ; le jeu complet est remplacé à chaque scrape d'un
    -- ami (delete + reinsert), pas mis à jour ligne à ligne.
    CREATE TABLE IF NOT EXISTS affiliate_orgs (
      friend_id TEXT NOT NULL,
      org_name TEXT NOT NULL,
      org_url TEXT,
      org_rank TEXT,
      PRIMARY KEY (friend_id, org_name)
    );
  `);

  // v1.0.11 a introduit `presence_log` (statut de présence uniquement) ;
  // remplacé ici par `change_log`, plus général (statut + pseudo + nom
  // affiché). Migration des lignes déjà écrites chez les utilisateurs qui
  // ont cette version, plutôt que de les perdre silencieusement.
  const hasOldPresenceLog = _db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='presence_log';`)
    .get();
  if (hasOldPresenceLog) {
    _db.exec(`
      INSERT INTO change_log (friend_id, field, value, changed_at)
      SELECT friend_id, 'presence', status, changed_at FROM presence_log;
      DROP TABLE presence_log;
    `);
  }

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
  if (!columns.includes('tags')) {
    _db.exec(`ALTER TABLE friends ADD COLUMN tags TEXT;`);
  }
  if (!columns.includes('bio')) {
    // "signature" et "spoken_languages" côté Spectrum — stockées pour
    // pouvoir détecter leurs changements d'un import à l'autre, comme
    // nickname/displayname (voir import-friends.js). Pas affichées dans le
    // tableau principal, juste suivies dans change_log. `languages` est une
    // liste triée jointe par virgule (ordre stable pour la comparaison).
    _db.exec(`
      ALTER TABLE friends ADD COLUMN bio TEXT;
      ALTER TABLE friends ADD COLUMN languages TEXT;
    `);
  }
  if (!columns.includes('enlisted_at')) {
    // enlisted_at/profile_fetched_at : remplis par fetch-profiles.js (page
    // publique RSI, pas l'API Spectrum). profile_fetched_at sert à reprendre
    // le scrape là où il s'était arrêté (jamais scrapé d'abord, puis les
    // plus anciens) plutôt que de tout refaire à chaque lancement.
    _db.exec(`
      ALTER TABLE friends ADD COLUMN enlisted_at TEXT;
      ALTER TABLE friends ADD COLUMN profile_fetched_at TEXT;
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
