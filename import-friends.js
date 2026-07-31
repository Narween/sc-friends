// Charge friends.json dans une base SQLite (friends.db). Upsert : les
// colonnes de données (nickname, présence...) sont rafraîchies, mais la
// colonne `decision` (choix local qui reste/qui part) n'est jamais écrasée
// par un re-import.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DB_FILE = process.argv.includes('--db')
  ? process.argv[process.argv.indexOf('--db') + 1]
  : 'friends.db';
const INPUT_FILE = 'friends.json';

function sqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function sqlNum(v) {
  return v === null || v === undefined ? 'NULL' : Number(v);
}

function runSql(sql) {
  const tmpFile = path.join(os.tmpdir(), `sc-friends-import-${process.pid}.sql`);
  fs.writeFileSync(tmpFile, sql);
  try {
    execFileSync('sqlite3', [DB_FILE], { input: fs.readFileSync(tmpFile), stdio: ['pipe', 'inherit', 'inherit'] });
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

function main() {
  const friends = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));

  const schema = `
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
`;

  const inserts = friends.map((f) => {
    const cols = {
      id: sqlStr(f.id),
      nickname: sqlStr(f.nickname),
      displayname: sqlStr(f.displayname),
      avatar: sqlStr(f.avatar),
      presence_status: sqlStr(f.presence?.status ?? null),
      presence_since: sqlNum(f.presence?.since ?? null),
      common_communities_count: (f.common_communities?.length ?? 0),
      raw_json: sqlStr(JSON.stringify(f)),
    };
    return `INSERT INTO friends (id, nickname, displayname, avatar, presence_status, presence_since, common_communities_count, raw_json)
VALUES (${cols.id}, ${cols.nickname}, ${cols.displayname}, ${cols.avatar}, ${cols.presence_status}, ${cols.presence_since}, ${cols.common_communities_count}, ${cols.raw_json})
ON CONFLICT(id) DO UPDATE SET
  nickname=excluded.nickname,
  displayname=excluded.displayname,
  avatar=excluded.avatar,
  presence_status=excluded.presence_status,
  presence_since=excluded.presence_since,
  common_communities_count=excluded.common_communities_count,
  raw_json=excluded.raw_json,
  updated_at=CURRENT_TIMESTAMP;`;
  });

  runSql(schema + '\nBEGIN;\n' + inserts.join('\n') + '\nCOMMIT;\n');

  const total = execFileSync('sqlite3', [DB_FILE, 'SELECT COUNT(*) FROM friends;']).toString().trim();
  console.log(`Import terminé -> ${DB_FILE} (${total} ligne(s) au total).`);
}

main();
