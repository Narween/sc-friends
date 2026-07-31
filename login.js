// Étape 1 : ouvre Spectrum (RSI), laisse l'utilisateur se connecter à la main,
// puis sauvegarde le storageState (cookies + localStorage) dans auth.json.
//
// Se synchronise via un fichier signal (plutôt qu'un appui sur Entrée) : dans
// l'appli Electron, le bouton "Je suis connecté" du panneau setup le crée ;
// en usage CLI pur, n'importe quel outil externe peut faire pareil.
const fs = require('node:fs');
const { chromium } = require('playwright');
const { AUTH_FILE, LOGIN_SIGNAL_FILE } = require('./lib/paths');

const START_URL = 'https://robertsspaceindustries.com/connect?jumpto=/spectrum';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  fs.rmSync(LOGIN_SIGNAL_FILE, { force: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });

  console.log('\nUne fenêtre Chromium est ouverte sur Spectrum.');
  console.log('Connecte-toi normalement (identifiants + éventuel 2FA).');
  console.log(`En attente du signal (${LOGIN_SIGNAL_FILE})...\n`);

  while (!fs.existsSync(LOGIN_SIGNAL_FILE)) {
    await sleep(1000);
  }
  fs.rmSync(LOGIN_SIGNAL_FILE, { force: true });

  await context.storageState({ path: AUTH_FILE });
  console.log(`\nSession sauvegardée dans ${AUTH_FILE}.`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
