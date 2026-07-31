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
      detail = `ligne ambiguë ou introuvable (${rowCount} correspondance(s))`;
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
      } catch (err) {
        detail = String(err);
      }
    }

    if (ok) okCount++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${friend.nickname} [id=${friend.id}] -> ${detail}`);

    updateStmt.run(ok ? 1 : 0, detail, friend.id);

    await sleep(DELAY_MS);
  }

  await browser.close();

  console.log(`\n${okCount} / ${pending.length} suppressions réussies. État à jour dans friends.db.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
