// Suppression en masse d'amis à partir d'un fichier de candidats (produit par
// filter-friends.js). SANS --confirm, ce script ne fait AUCUN appel réseau :
// il se contente d'afficher qui serait retiré. Il faut passer --confirm
// explicitement pour exécuter réellement les suppressions.
//
// Usage :
//   node remove-friends.js --file candidates.6mo.json            (dry-run, ne supprime rien)
//   node remove-friends.js --file candidates.6mo.json --confirm  (exécute réellement)
const fs = require('node:fs');
const { chromium } = require('playwright');

const AUTH_FILE = 'auth.json';
const START_URL = 'https://robertsspaceindustries.com/spectrum';
const DELAY_MS = 1500;

function parseArgs(argv) {
  const args = { file: null, confirm: false, log: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--log') args.log = argv[++i];
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('Usage: node remove-friends.js --file candidates.Xmo.json [--confirm] [--log fichier.json]');
    process.exit(1);
  }

  const candidates = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  console.log(`${candidates.length} ami(s) dans ${args.file} :`);
  candidates.forEach((f) => console.log(`  - ${f.nickname} (${f.displayname}) [id=${f.id}]`));

  if (!args.confirm) {
    console.log(`\nDRY-RUN : aucun appel réseau effectué. Relance avec --confirm pour exécuter réellement les ${candidates.length} suppression(s).`);
    return;
  }

  if (!fs.existsSync(AUTH_FILE)) {
    console.error(`Fichier ${AUTH_FILE} introuvable. Lance d'abord login.js.`);
    process.exit(1);
  }

  console.log(`\n--confirm passé : suppression réelle de ${candidates.length} ami(s), pause ${DELAY_MS}ms entre chaque appel.\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: AUTH_FILE });
  const page = await context.newPage();

  // On charge l'app pour que son bundle JS initialise le fetch authentifié
  // (cookies + éventuel token CSRF géré côté client), comme lors d'un usage normal.
  await Promise.all([
    page.waitForResponse((res) => res.url().includes('/api/spectrum/auth/identify'), { timeout: 30000 }),
    page.goto(START_URL, { waitUntil: 'domcontentloaded' }),
  ]);

  const results = [];
  for (const friend of candidates) {
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
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${friend.nickname} [id=${friend.id}] -> HTTP ${result.status} ${JSON.stringify(result.body)}`);
    results.push({ id: friend.id, nickname: friend.nickname, ok, httpStatus: result.status, response: result.body, error: result.error });

    await sleep(DELAY_MS);
  }

  await browser.close();

  const logFile = args.log || `remove-log.${Date.now()}.json`;
  fs.writeFileSync(logFile, JSON.stringify(results, null, 2));

  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n${okCount} / ${candidates.length} suppressions réussies. Détail -> ${logFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
