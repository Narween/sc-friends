// Étape 1 : ouvre Spectrum (RSI), laisse l'utilisateur se connecter à la main,
// puis sauvegarde le storageState (cookies + localStorage) dans auth.json.
//
// Comme ce script tourne en arrière-plan (pas de stdin interactif côté
// utilisateur), on attend un fichier signal au lieu d'un appui sur Entrée :
// il est créé par l'agent une fois que l'utilisateur confirme par chat
// qu'il est connecté.
const fs = require('node:fs');
const { chromium } = require('playwright');

// L'API embarque signin-url = https://robertsspaceindustries.com/connect?jumpto=/spectrum
const START_URL = 'https://robertsspaceindustries.com/connect?jumpto=/spectrum';
const AUTH_FILE = 'auth.json';
const SIGNAL_FILE = '.login-done.signal';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  fs.rmSync(SIGNAL_FILE, { force: true });

  const browser = await chromium.launch({
    headless: false,
    args: ['--force-color-profile=generic-rgb', '--disable-lcd-text'],
  });
  const context = await browser.newContext();

  // On coupe images/médias/polices : inutiles pour se connecter, et ce sont
  // elles qui rendent le VNC illisible sur une liaison lente (vidéo de fond,
  // carrousel...). Le formulaire de connexion reste pleinement fonctionnel.
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') {
      return route.abort();
    }
    return route.continue();
  });

  const page = await context.newPage();

  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });

  console.log('\nUne fenêtre Chromium est ouverte sur Spectrum.');
  console.log('Connecte-toi normalement (identifiants + éventuel 2FA).');
  console.log(`En attente du signal (${SIGNAL_FILE})...\n`);

  while (!fs.existsSync(SIGNAL_FILE)) {
    await sleep(1000);
  }
  fs.rmSync(SIGNAL_FILE, { force: true });

  await context.storageState({ path: AUTH_FILE });
  console.log(`\nSession sauvegardée dans ${AUTH_FILE}.`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
