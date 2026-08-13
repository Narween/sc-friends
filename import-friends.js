// Charge friends.json dans friends.db (better-sqlite3). Upsert : les
// colonnes de données (nickname, présence...) sont rafraîchies, mais la
// colonne `decision` (choix local qui reste/qui part) n'est jamais écrasée
// par un re-import.
const fs = require('node:fs');
const { getDb } = require('./lib/db');
const { FRIENDS_JSON_FILE } = require('./lib/paths');
const { log } = require('./lib/log');
const { extractOrg } = require('./lib/org');

function main() {
  const friends = JSON.parse(fs.readFileSync(FRIENDS_JSON_FILE, 'utf8'));
  const db = getDb();

  const getExisting = db.prepare(`SELECT presence_status, nickname, displayname, bio, languages FROM friends WHERE id=?;`);
  const logChange = db.prepare(`INSERT INTO change_log (friend_id, field, value, changed_at) VALUES (?, ?, ?, ?);`);

  const upsert = db.prepare(`
    INSERT INTO friends (id, nickname, displayname, avatar, presence_status, presence_since, common_communities_count, org_name, org_url, org_redacted, bio, languages, raw_json)
    VALUES (@id, @nickname, @displayname, @avatar, @presence_status, @presence_since, @common_communities_count, @org_name, @org_url, @org_redacted, @bio, @languages, @raw_json)
    ON CONFLICT(id) DO UPDATE SET
      nickname=excluded.nickname,
      displayname=excluded.displayname,
      avatar=excluded.avatar,
      presence_status=excluded.presence_status,
      presence_since=excluded.presence_since,
      common_communities_count=excluded.common_communities_count,
      org_name=excluded.org_name,
      org_url=excluded.org_url,
      org_redacted=excluded.org_redacted,
      bio=excluded.bio,
      languages=excluded.languages,
      raw_json=excluded.raw_json,
      updated_at=CURRENT_TIMESTAMP;
  `);

  const importAll = db.transaction((rows) => {
    const now = new Date().toISOString();
    for (const f of rows) {
      const org = extractOrg(f);
      const newStatus = f.presence?.status ?? null;
      const newNickname = f.nickname ?? null;
      const newDisplayname = f.displayname ?? null;
      const newBio = f.signature ?? null;
      // Liste triée + jointe : l'API peut renvoyer les langues dans un ordre
      // différent d'un fetch à l'autre sans que ça reflète un vrai
      // changement — trier avant de comparer évite des lignes d'historique
      // parasites pour un simple réordonnancement.
      const newLanguages = (f.spoken_languages || []).slice().sort().join(',') || null;
      // Ligne d'historique seulement si la valeur a vraiment changé depuis
      // le dernier import connu — sinon chaque simple rafraîchissement (même
      // sans changement réel) gonflerait la table pour rien. Le tout premier
      // import d'un ami (pas de ligne existante) n'écrit rien non plus : ce
      // n'est pas une "transition", juste l'état de départ.
      const existing = getExisting.get(f.id);
      if (existing) {
        if (existing.presence_status !== newStatus) logChange.run(f.id, 'presence', newStatus, now);
        if (existing.nickname !== newNickname) logChange.run(f.id, 'nickname', newNickname, now);
        if (existing.displayname !== newDisplayname) logChange.run(f.id, 'displayname', newDisplayname, now);
        if (existing.bio !== newBio) logChange.run(f.id, 'bio', newBio, now);
        if (existing.languages !== newLanguages) logChange.run(f.id, 'languages', newLanguages, now);
      }
      upsert.run({
        id: f.id,
        nickname: newNickname,
        displayname: newDisplayname,
        avatar: f.avatar ?? null,
        presence_status: newStatus,
        presence_since: f.presence?.since ?? null,
        common_communities_count: f.common_communities?.length ?? 0,
        org_name: org.name,
        org_url: org.url,
        org_redacted: org.redacted,
        bio: newBio,
        languages: newLanguages,
        raw_json: JSON.stringify(f),
      });
    }
  });

  importAll(friends);

  const total = db.prepare('SELECT COUNT(*) as n FROM friends').get().n;
  log('cli.import.done', { count: total });
}

main();
