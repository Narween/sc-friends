// Étape 2 (découverte) : recharge auth.json, intercepte tout le trafic JSON
// pendant que tu navigues manuellement vers ta liste d'amis (et que tu la
// fais paginer/scroller une fois), puis dump tout le réseau capturé et
// essaie de repérer automatiquement l'objet "liste d'amis" pour qu'on
// puisse en inspecter la structure avant d'écrire la vraie boucle de
// pagination.
const fs = require('node:fs');
const { chromium } = require('playwright');

const START_URL = 'https://robertsspaceindustries.com/spectrum';
const AUTH_FILE = 'auth.json';
const CAPTURE_FILE = 'network-capture.json';
const CANDIDATE_FILE = 'friends.candidate.json';
const SIGNAL_FILE = '.discover-done.signal';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Cherche récursivement, dans un JSON quelconque, les tableaux d'objets
// "similaires" (même forme de clés) — candidats plausibles pour une liste
// paginée d'amis.
function findObjectArrays(node, path, out) {
  if (Array.isArray(node)) {
    if (node.length > 0 && node.every(isPlainObject)) {
      out.push({ path, length: node.length, sample: node[0] });
    }
    node.forEach((child, i) => findObjectArrays(child, `${path}[${i}]`, out));
  } else if (isPlainObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      findObjectArrays(value, path ? `${path}.${key}` : key, out);
    }
  }
}

async function main() {
  if (!fs.existsSync(AUTH_FILE)) {
    console.error(`Fichier ${AUTH_FILE} introuvable. Lance d'abord login.js.`);
    process.exit(1);
  }
  fs.rmSync(SIGNAL_FILE, { force: true });

  const browser = await chromium.launch({
    headless: false,
    args: ['--window-size=1680,1000', '--window-position=0,0'],
  });
  const context = await browser.newContext({
    storageState: AUTH_FILE,
    viewport: { width: 1680, height: 960 },
  });
  const page = await context.newPage();

  const captured = [];

  page.on('response', async (response) => {
    try {
      const url = response.url();
      // On ne garde que l'API Spectrum (window.Tavern.config.api_root =
      // "/api/spectrum") pour éviter le bruit (analytics, Sentry, CDN...).
      if (!url.includes('/api/spectrum')) return;

      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('json')) return;

      const request = response.request();
      let bodyText;
      try {
        bodyText = await response.text();
      } catch {
        return; // réponse déjà consommée / stream fermé
      }

      let body;
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }

      captured.push({
        url: response.url(),
        method: request.method(),
        status: response.status(),
        postData: request.postData() || null,
        body,
      });
      console.log(`[capture] ${request.method()} ${response.status()} ${response.url()}`);
    } catch {
      // on ignore les réponses problématiques, ça ne doit pas casser la capture
    }
  });

  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });

  console.log('\nSession rechargée depuis auth.json.');
  console.log("Navigue manuellement jusqu'à ta liste d'amis, puis fais défiler /");
  console.log("clique sur la pagination pour charger toutes les pages au moins une fois.");
  console.log(`En attente du signal d'arrêt (${SIGNAL_FILE})...\n`);

  while (!fs.existsSync(SIGNAL_FILE)) {
    await sleep(1000);
  }
  fs.rmSync(SIGNAL_FILE, { force: true });

  fs.writeFileSync(CAPTURE_FILE, JSON.stringify(captured, null, 2));
  console.log(`\n${captured.length} réponses JSON capturées -> ${CAPTURE_FILE}`);

  // Heuristique : on cherche parmi toutes les réponses capturées les
  // tableaux d'objets plausibles, en priorisant les URLs qui contiennent
  // "friend".
  const candidates = [];
  for (const entry of captured) {
    if (typeof entry.body !== 'object' || entry.body === null) continue;
    const arrays = [];
    findObjectArrays(entry.body, '', arrays);
    for (const arr of arrays) {
      candidates.push({ ...arr, url: entry.url, method: entry.method });
    }
  }

  candidates.sort((a, b) => {
    const aScore = /friend/i.test(a.url) ? 1 : 0;
    const bScore = /friend/i.test(b.url) ? 1 : 0;
    if (aScore !== bScore) return bScore - aScore;
    return b.length - a.length;
  });

  if (candidates.length === 0) {
    console.log('\nAucun tableau d\'objets JSON détecté dans le trafic capturé.');
    console.log(`Regarde ${CAPTURE_FILE} à la main pour identifier l'endpoint.`);
    await browser.close();
    return;
  }

  const best = candidates[0];
  fs.writeFileSync(CANDIDATE_FILE, JSON.stringify(best, null, 2));

  console.log('\n=== Meilleur candidat pour la liste d\'amis ===');
  console.log(`URL      : ${best.method} ${best.url}`);
  console.log(`Chemin   : body${best.path ? '.' + best.path : ''}`);
  console.log(`Taille   : ${best.length} élément(s) dans cette réponse`);
  console.log('Structure d\'un objet ami (échantillon) :');
  console.log(JSON.stringify(best.sample, null, 2));
  console.log(`\n(candidat complet écrit dans ${CANDIDATE_FILE})`);

  if (candidates.length > 1) {
    console.log(`\n${candidates.length - 1} autre(s) tableau(x) candidat(s) trouvé(s) dans ${CAPTURE_FILE} si celui-ci n'est pas le bon.`);
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
