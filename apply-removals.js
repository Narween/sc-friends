// Applique réellement sur Spectrum les décisions decision='remove' prises
// localement dans friends.db. SANS --confirm : dry-run, aucun appel réseau,
// juste la liste de ce qui serait supprimé.
//
// Fonctionne en pilotant la VRAIE page de gestion des amis
// (https://.../spectrum/settings/friends : recherche + bouton UNFRIEND par
// ligne), pas en rejouant l'appel API à la main : Spectrum protège cet appel
// avec un header anti-bot (x-rsi-token) calculé par son propre bundle JS
// interne, qu'on ne peut pas reproduire nous-mêmes sans contourner cette
// protection. En cliquant le vrai bouton, ce header est posé naturellement
// par le code du site.
//
// Idempotent : chaque ligne traitée est marquée applied_at immédiatement,
// donc une exécution interrompue peut être relancée sans risquer de
// re-supprimer les mêmes amis.
//
// Usage :
//   node apply-removals.js                 (dry-run)
//   node apply-removals.js --confirm       (exécute réellement)
//   node apply-removals.js --confirm --limit 3   (teste sur un petit lot avant le reste)
const fs = require('node:fs');
const { chromium } = require('playwright');
const { getDb } = require('./lib/db');
const { AUTH_FILE } = require('./lib/paths');
const { log, err, lang } = require('./lib/log');
const { t } = require('./lib/i18n');

const FRIENDS_SETTINGS_URL = 'https://robertsspaceindustries.com/spectrum/settings/friends';
const DELAY_MS = 2000;

function parseArgs(argv) {
  const args = { confirm: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') args.confirm = true;
    else if (a === '--limit') args.limit = Number(argv[++i]);
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();

  const limitClause = args.limit ? ` LIMIT ${Number(args.limit)}` : '';
  const pending = db
    .prepare(`SELECT id, nickname, displayname FROM friends WHERE decision='remove' AND applied_at IS NULL ORDER BY id${limitClause};`)
    .all();

  log('cli.apply.pendingList', { count: pending.length });
  pending.forEach((f) => console.log(`  - ${f.nickname} [id=${f.id}]`));

  if (!args.confirm) {
    log('cli.apply.dryRun');
    return;
  }
  if (pending.length === 0) {
    log('cli.apply.nothing');
    return;
  }
  if (!fs.existsSync(AUTH_FILE)) {
    err('cli.fetch.authMissing', { file: AUTH_FILE });
    process.exit(1);
  }

  log('cli.apply.confirmed', { count: pending.length, delay: DELAY_MS });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: AUTH_FILE, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  await page.goto(FRIENDS_SETTINGS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const filterInput = await page.waitForSelector('input[placeholder="Filter friends"]', { timeout: 30000 });

  const updateStmt = db.prepare(
    `UPDATE friends SET applied_at=CURRENT_TIMESTAMP, apply_success=?, apply_response=? WHERE id=?;`
  );

  let okCount = 0;
  for (const friend of pending) {
    let ok = false;
    let detail = null;

    // Le champ de recherche de la page filtre sur le displayname ("Name"),
    // pas sur le nickname ("Handle") — les deux peuvent différer.
    await filterInput.fill(friend.displayname);
    await sleep(1800);

    const row = page.locator('.table-row').filter({ hasText: friend.displayname }).filter({ hasText: friend.nickname });
    const rowCount = await row.count();

    if (rowCount !== 1) {
      detail = t(lang, 'cli.apply.rowNotFound', { count: rowCount });
    } else {
      const unfriendBtn = row.locator('.table-cell.action');
      try {
        const [response] = await Promise.all([
          page.waitForResponse((res) => res.url().includes('/api/spectrum/friend/remove'), { timeout: 10000 }),
          unfriendBtn.click(),
        ]);
        const body = await response.json().catch(() => null);
        ok = body?.success === 1;
        detail = JSON.stringify(body);
      } catch (e) {
        detail = String(e);
      }
    }

    if (ok) okCount++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${friend.nickname} [id=${friend.id}] -> ${detail}`);

    updateStmt.run(ok ? 1 : 0, detail, friend.id);

    await sleep(DELAY_MS);
  }

  await browser.close();

  log('cli.apply.summary', { ok: okCount, total: pending.length });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
