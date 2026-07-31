// Étape 2 (final) : recharge auth.json et récupère la liste d'amis complète.
// Découverte faite via discover-friends.js : Spectrum ne pagine pas côté API,
// l'appel POST /api/spectrum/auth/identify (déclenché automatiquement au
// chargement de l'app) renvoie déjà body.data.friends au complet (794 items
// vus lors du test). On se contente donc de rejouer ce chargement en
// headless et de dumper ce tableau brut dans friends.json.
const fs = require('node:fs');
const { chromium } = require('playwright');

const START_URL = 'https://robertsspaceindustries.com/spectrum';
const AUTH_FILE = 'auth.json';
const OUTPUT_FILE = 'friends.json';

async function main() {
  if (!fs.existsSync(AUTH_FILE)) {
    console.error(`Fichier ${AUTH_FILE} introuvable. Lance d'abord login.js.`);
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
    console.error('Réponse inattendue (pas de tableau data.friends) :');
    console.error(JSON.stringify(body, null, 2).slice(0, 2000));
    await browser.close();
    process.exit(1);
  }

  const friends = body.data.friends;
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(friends, null, 2));

  console.log(`${friends.length} amis récupérés -> ${OUTPUT_FILE}`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
