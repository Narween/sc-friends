// Étape 2 (final) : recharge auth.json et récupère la liste d'amis complète.
// Découverte faite via discover-friends.js : Spectrum ne pagine pas côté API,
// l'appel POST /api/spectrum/auth/identify (déclenché automatiquement au
// chargement de l'app) renvoie déjà body.data.friends au complet (794 items
// vus lors du test). On se contente donc de rejouer ce chargement en
// headless et de dumper ce tableau brut dans friends.json.
const fs = require('node:fs');
const { chromium } = require('playwright');
const { AUTH_FILE, FRIENDS_JSON_FILE } = require('./lib/paths');
const { log, err } = require('./lib/log');

const START_URL = 'https://robertsspaceindustries.com/spectrum';

async function main() {
  if (!fs.existsSync(AUTH_FILE)) {
    err('cli.fetch.authMissing', { file: AUTH_FILE });
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: AUTH_FILE });
  const page = await context.newPage();

  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/spectrum/auth/identify') && res.request().method() === 'POST',
      { timeout: 30000 }
    ),
    page.goto(START_URL, { waitUntil: 'domcontentloaded' }),
  ]);

  const body = await response.json();

  if (!body?.success || !Array.isArray(body?.data?.friends)) {
    err('cli.fetch.unexpectedResponse');
    console.error(JSON.stringify(body, null, 2).slice(0, 2000));
    await browser.close();
    process.exit(1);
  }

  const friends = body.data.friends;
  fs.writeFileSync(FRIENDS_JSON_FILE, JSON.stringify(friends, null, 2));

  log('cli.fetch.done', { count: friends.length, file: FRIENDS_JSON_FILE });

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
