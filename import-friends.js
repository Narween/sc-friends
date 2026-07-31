// Charge friends.json dans friends.db (better-sqlite3). Upsert : les
// colonnes de données (nickname, présence...) sont rafraîchies, mais la
// colonne `decision` (choix local qui reste/qui part) n'est jamais écrasée
// par un re-import.
const fs = require('node:fs');
const { getDb } = require('./lib/db');
const { FRIENDS_JSON_FILE } = require('./lib/paths');
const { log } = require('./lib/log');

function main() {
  const friends = JSON.parse(fs.readFileSync(FRIENDS_JSON_FILE, 'utf8'));
  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO friends (id, nickname, displayname, avatar, presence_status, presence_since, common_communities_count, raw_json)
    VALUES (@id, @nickname, @displayname, @avatar, @presence_status, @presence_since, @common_communities_count, @raw_json)
    ON CONFLICT(id) DO UPDATE SET
      nickname=excluded.nickname,
      displayname=excluded.displayname,
      avatar=excluded.avatar,
      presence_status=excluded.presence_status,
      presence_since=excluded.presence_since,
      common_communities_count=excluded.common_communities_count,
      raw_json=excluded.raw_json,
      updated_at=CURRENT_TIMESTAMP;
  `);

  const importAll = db.transaction((rows) => {
    for (const f of rows) {
      upsert.run({
        id: f.id,
        nickname: f.nickname ?? null,
        displayname: f.displayname ?? null,
        avatar: f.avatar ?? null,
        presence_status: f.presence?.status ?? null,
        presence_since: f.presence?.since ?? null,
        common_communities_count: f.common_communities?.length ?? 0,
        raw_json: JSON.stringify(f),
      });
    }
  });

  importAll(friends);

  const total = db.prepare('SELECT COUNT(*) as n FROM friends').get().n;
  log('cli.import.done', { count: total });
}

main();
