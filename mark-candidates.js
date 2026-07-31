// Marque en local (dans friends.db) les amis candidats à la suppression,
// selon des critères d'inactivité. Ne touche jamais au site : ça ne fait que
// mettre à jour la colonne `decision` de la base SQLite. Aucun appel réseau.
//
// Usage :
//   node mark-candidates.js --months 6                      (marque les nouveaux candidats en 'remove')
//   node mark-candidates.js --months 6 --any-status
//   node mark-candidates.js --months 6 --allow-common-org
//   node mark-candidates.js --reset                         (remet decision=NULL pour tout ce qui n'est pas encore appliqué)
//   node mark-candidates.js --keep <id>                      (force decision='keep' pour un ami précis)
const { getDb } = require('./lib/db');
const { log, err, lang } = require('./lib/log');
const { t } = require('./lib/i18n');

function parseArgs(argv) {
  const args = { months: null, anyStatus: false, allowCommonOrg: false, reset: false, keep: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--months') args.months = Number(argv[++i]);
    else if (a === '--any-status') args.anyStatus = true;
    else if (a === '--allow-common-org') args.allowCommonOrg = true;
    else if (a === '--reset') args.reset = true;
    else if (a === '--keep') args.keep = argv[++i];
  }
  return args;
}

function summary(db) {
  const undecidedLabel = `(${t(lang, 'row.undecided')})`;
  const rows = db
    .prepare(`SELECT COALESCE(decision, ?) as decision, COUNT(*) as n FROM friends WHERE applied_at IS NULL GROUP BY decision;`)
    .all(undecidedLabel);
  console.table(rows);
  const applied = db.prepare(`SELECT COUNT(*) as n FROM friends WHERE applied_at IS NOT NULL;`).get().n;
  log('cli.mark.appliedCount', { count: applied });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();

  if (args.reset) {
    db.prepare(`UPDATE friends SET decision=NULL, decided_at=NULL WHERE applied_at IS NULL;`).run();
    log('cli.mark.reset');
    summary(db);
    return;
  }

  if (args.keep) {
    db.prepare(`UPDATE friends SET decision='keep', decided_at=CURRENT_TIMESTAMP WHERE id=?;`).run(args.keep);
    log('cli.mark.keepSet', { id: args.keep });
    return;
  }

  if (!args.months) {
    err('cli.mark.usage');
    process.exit(1);
  }

  const cutoff = Math.floor(Date.now() / 1000) - args.months * 30 * 24 * 60 * 60;

  const conditions = ['applied_at IS NULL', '(presence_since IS NULL OR presence_since < ?)'];
  const params = [cutoff];
  if (!args.anyStatus) conditions.push(`presence_status = 'offline'`);
  if (!args.allowCommonOrg) conditions.push(`common_communities_count = 0`);

  const where = conditions.join(' AND ');
  db.prepare(`UPDATE friends SET decision='remove', decided_at=CURRENT_TIMESTAMP WHERE ${where};`).run(...params);

  const cutoffDate = new Date(cutoff * 1000).toISOString().slice(0, 10);
  log('cli.mark.threshold', { months: args.months, date: cutoffDate });
  log('cli.mark.filters', {
    status: args.anyStatus ? t(lang, 'cli.mark.statusAny') : t(lang, 'cli.mark.statusOfflineOnly'),
    org: args.allowCommonOrg ? t(lang, 'cli.mark.orgAllowed') : t(lang, 'cli.mark.orgNoneRequired'),
  });
  summary(db);
}

main();
