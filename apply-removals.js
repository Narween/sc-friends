// Applique réellement sur Spectrum les décisions decision='remove' prises
// localement dans friends.db. SANS --confirm : dry-run, aucun appel réseau,
// juste la liste de ce qui serait supprimé. Idempotent : chaque ligne traitée
// est marquée applied_at immédiatement, donc une exécution interrompue peut
// être relancée sans re-supprimer les mêmes amis.
//
// Usage :
//   node apply-removals.js                 (dry-run)
//   node apply-removals.js --confirm       (exécute réellement)
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const AUTH_FILE = 'auth.json';
const START_URL = 'https://robertsspaceindustries.com/spectrum';
const DELAY_MS = 1500;

function parseArgs(argv) {
  const args = { db: 'friends.db', confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') args.db = argv[++i];
    else if (a === '--confirm') args.confirm = true;
  }
  return args;
}

function sqlJson(db, statement) {
  const out = execFileSync('sqlite3', [db, '.mode json', statement]).toString().trim();
  return out ? JSON.parse(out) : [];
}
function sqlExec(db, statement) {
  execFileSync('sqlite3', [db, statement]);
}
function esc(v) {
  return String(v).replace(/'/g, "''");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const pending = sqlJson(args.db, `SELECT id, nickname FROM friends WHERE decision='remove' AND applied_at IS NULL;`);

  console.log(`${pending.length} ami(s) marqué(s) 'remove' et pas encore appliqué(s) :`);
  pending.forEach((f) => console.log(`  - ${f.nickname} [id=${f.id}]`));

  if (!args.confirm) {
    console.log(`\nDRY-RUN : aucun appel réseau effectué. Relance avec --confirm pour exécuter réellement.`);
    return;
  }
  if (pending.length === 0) {
    console.log('\nRien à appliquer.');
    return;
  }
  if (!fs.existsSync(AUTH_FILE)) {
    console.error(`Fichier ${AUTH_FILE} introuvable. Lance d'abord login.js.`);
    process.exit(1);
  }

  console.log(`\n--confirm passé : suppression réelle de ${pending.length} ami(s), pause ${DELAY_MS}ms entre chaque appel.\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: AUTH_FILE });
  const page = await context.newPage();

  await Promise.all([
    page.waitForResponse((res) => res.url().includes('/api/spectrum/auth/identify'), { timeout: 30000 }),
    page.goto(START_URL, { waitUntil: 'domcontentloaded' }),
  ]);

  let okCount = 0;
  for (const friend of pending) {
    let result;
    try {
      result = await page.evaluate(async (memberId) => {
        const res = await fetch('/api/spectrum/friend/remove', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ member_id: memberId }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      }, friend.id);
    } catch (err) {
      result = { status: null, body: null, error: String(err) };
    }

    const ok = result.body?.success === 1;
    if (ok) okCount++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${friend.nickname} [id=${friend.id}] -> HTTP ${result.status} ${JSON.stringify(result.body)}`);

    sqlExec(
      args.db,
      `UPDATE friends SET applied_at=CURRENT_TIMESTAMP, apply_success=${ok ? 1 : 0}, apply_response='${esc(JSON.stringify(result.body ?? result.error ?? null))}' WHERE id='${esc(friend.id)}';`
    );

    await sleep(DELAY_MS);
  }

  await browser.close();

  console.log(`\n${okCount} / ${pending.length} suppressions réussies. État à jour dans ${args.db}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
