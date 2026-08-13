// Scrape la page profil public RSI de chaque ami (pas l'API interne
// Spectrum, une page HTML publique séparée) pour récupérer sa date
// d'enlistement et ses orgs affiliées (secondaires) — deux infos que l'API
// utilisée par fetch-friends.js n'expose pas du tout.
//
// Deux pages HTML par ami (profil + onglet "organizations"), donc ~2x le
// nombre d'amis en requêtes pour un passage complet. Volontairement très
// lent : un lot de 5 amis, puis une pause d'environ 3 minutes (avec un peu
// de hasard) avant le lot suivant — descendre plus bas ressemblerait à du
// scraping agressif aux yeux d'une détection anti-bot. Reprend là où il
// s'était arrêté d'une exécution à l'autre (profile_fetched_at : jamais
// scrapés d'abord, puis les plus anciens), donc pas besoin de le laisser
// tourner d'un seul bloc ni de tout refaire à chaque lancement.
//
// Usage :
//   node fetch-profiles.js                 (tous les amis pas encore appliqués, dans l'ordre de fraîcheur)
//   node fetch-profiles.js --limit 5        (teste sur un petit lot)
const { chromium } = require('playwright');
const { getDb } = require('./lib/db');
const { log, err } = require('./lib/log');

const PROFILE_URL = (nickname) => `https://robertsspaceindustries.com/citizens/${encodeURIComponent(nickname)}`;
const ORGS_URL = (nickname) => `https://robertsspaceindustries.com/citizens/${encodeURIComponent(nickname)}/organizations`;

const BATCH_SIZE = 5;
const BATCH_PAUSE_MS = [150_000, 210_000]; // ~2min30 à 3min30
const PAGE_PAUSE_MS = [2000, 5000]; // entre les 2 pages d'un même ami

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = ([min, max]) => min + Math.random() * (max - min);

function parseArgs(argv) {
  const args = { limit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = Number(argv[++i]);
  }
  return args;
}

async function scrapeEnlisted(page, nickname) {
  await page.goto(PROFILE_URL(nickname), { waitUntil: 'domcontentloaded', timeout: 30000 });
  return page.evaluate(() => {
    const entries = [...document.querySelectorAll('.entry')];
    const entry = entries.find((e) => e.querySelector('.label')?.textContent.trim() === 'Enlisted');
    return entry?.querySelector('.value')?.textContent.trim() || null;
  });
}

async function scrapeAffiliates(page, nickname) {
  await page.goto(ORGS_URL(nickname), { waitUntil: 'domcontentloaded', timeout: 30000 });
  return page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.box-content.org.affiliation')];
    return boxes
      .map((box) => {
        const nameLink = box.querySelector('.entry.orgtitle a.value');
        const rankEntry = [...box.querySelectorAll('.entry')].find(
          (e) => e.querySelector('.label')?.textContent.trim() === 'Organization rank'
        );
        return {
          name: nameLink?.textContent.trim() || null,
          url: nameLink ? 'https://robertsspaceindustries.com' + nameLink.getAttribute('href') : null,
          rank: rankEntry?.querySelector('.value')?.textContent.trim() || null,
        };
      })
      .filter((a) => a.name);
  });
}

async function main() {
  const { limit } = parseArgs(process.argv.slice(2));
  const db = getDb();

  // Jamais scrapés (profile_fetched_at NULL) en premier, puis les plus
  // anciennement scrapés — pour qu'un run interrompu ou relancé plus tard
  // continue là où il en était plutôt que de repartir de zéro. Les amis déjà
  // appliqués (supprimés pour de vrai) sont exclus, ça ne sert plus à rien.
  const friends = db
    .prepare(
      `SELECT id, nickname FROM friends
       WHERE applied_at IS NULL
       ORDER BY (profile_fetched_at IS NOT NULL), profile_fetched_at ASC
       ${Number.isInteger(limit) && limit > 0 ? 'LIMIT ?' : ''};`
    )
    .all(...(Number.isInteger(limit) && limit > 0 ? [limit] : []));

  if (!friends.length) {
    log('cli.profiles.nothing');
    return;
  }

  const getExisting = db.prepare(`SELECT enlisted_at FROM friends WHERE id=?;`);
  const getExistingAffiliates = db.prepare(`SELECT org_name FROM affiliate_orgs WHERE friend_id=? ORDER BY org_name;`);
  const updateFriend = db.prepare(`UPDATE friends SET enlisted_at=?, profile_fetched_at=? WHERE id=?;`);
  const deleteAffiliates = db.prepare(`DELETE FROM affiliate_orgs WHERE friend_id=?;`);
  const insertAffiliate = db.prepare(
    `INSERT INTO affiliate_orgs (friend_id, org_name, org_url, org_rank) VALUES (?, ?, ?, ?);`
  );
  const logChange = db.prepare(`INSERT INTO change_log (friend_id, field, value, changed_at) VALUES (?, ?, ?, ?);`);

  log('cli.profiles.start', { count: friends.length });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let done = 0;
  for (let i = 0; i < friends.length; i += BATCH_SIZE) {
    const batch = friends.slice(i, i + BATCH_SIZE);

    for (const friend of batch) {
      try {
        const enlistedAt = await scrapeEnlisted(page, friend.nickname);
        await sleep(randomBetween(PAGE_PAUSE_MS));
        const affiliates = await scrapeAffiliates(page, friend.nickname);

        const now = new Date().toISOString();
        const existing = getExisting.get(friend.id);
        if (existing && existing.enlisted_at !== enlistedAt) {
          logChange.run(friend.id, 'enlisted_at', enlistedAt, now);
        }
        const prevNames = getExistingAffiliates.all(friend.id).map((r) => r.org_name).join(',');
        const newNames = affiliates.map((a) => a.name).sort().join(',');
        if (prevNames !== newNames) {
          logChange.run(friend.id, 'affiliate_orgs', newNames || null, now);
        }

        const tx = db.transaction(() => {
          updateFriend.run(enlistedAt, now, friend.id);
          deleteAffiliates.run(friend.id);
          for (const a of affiliates) insertAffiliate.run(friend.id, a.name, a.url, a.rank);
        });
        tx();

        done++;
        log('cli.profiles.progress', { done, total: friends.length, nickname: friend.nickname });
      } catch (e) {
        err('cli.profiles.error', { nickname: friend.nickname, message: String(e?.message || e) });
      }
    }

    if (i + BATCH_SIZE < friends.length) {
      const pauseMs = randomBetween(BATCH_PAUSE_MS);
      log('cli.profiles.pausing', { seconds: Math.round(pauseMs / 1000) });
      await sleep(pauseMs);
    }
  }

  await browser.close();
  log('cli.profiles.done', { count: done });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
