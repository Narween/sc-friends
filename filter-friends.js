// Filtre en lecture seule sur friends.json : identifie les amis candidats à
// la suppression selon une inactivité (presence.since). Ne fait aucun appel
// réseau, ne supprime rien — écrit juste une liste de candidats à relire.
//
// Usage interactif (menu)      : node filter-friends.js
// Usage scripté (sans menu)    : node filter-friends.js --months 6 [--any-status] [--allow-common-org] [--out fichier.json]
const fs = require('node:fs');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const THRESHOLD_PRESETS = [1, 2, 3, 6, 12, 18, 24];

function parseArgs(argv) {
  const args = { months: null, anyStatus: false, allowCommonOrg: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--months') args.months = Number(argv[++i]);
    else if (a === '--any-status') args.anyStatus = true;
    else if (a === '--allow-common-org') args.allowCommonOrg = true;
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

async function runMenu() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log("\nSeuil d'inactivité (basé sur presence.since) :");
  THRESHOLD_PRESETS.forEach((m, i) => console.log(`  ${i + 1}) ${m} mois`));
  console.log(`  ${THRESHOLD_PRESETS.length + 1}) Personnalisé (nombre de mois au choix)`);

  let months = null;
  while (months === null) {
    const answer = (await rl.question(`Choix [1-${THRESHOLD_PRESETS.length + 1}] : `)).trim();
    const idx = Number(answer);
    if (idx >= 1 && idx <= THRESHOLD_PRESETS.length) {
      months = THRESHOLD_PRESETS[idx - 1];
    } else if (idx === THRESHOLD_PRESETS.length + 1) {
      const custom = (await rl.question('Nombre de mois : ')).trim();
      if (Number(custom) > 0) months = Number(custom);
    }
    if (months === null) console.log('Choix invalide, réessaie.');
  }

  const anyStatusAns = (await rl.question("Exiger le statut 'offline' ? [O/n] : ")).trim().toLowerCase();
  const anyStatus = anyStatusAns === 'n';

  const allowCommonOrgAns = (await rl.question('Exiger aucune org/communauté commune ? [O/n] : ')).trim().toLowerCase();
  const allowCommonOrg = allowCommonOrgAns === 'n';

  rl.close();
  return { months, anyStatus, allowCommonOrg, out: null };
}

function applyFilter(friends, args) {
  const cutoffMs = Date.now() - args.months * 30 * 24 * 60 * 60 * 1000;

  return friends.filter((f) => {
    const since = f.presence?.since;
    const isOldOrUnknown = since === null || since === undefined || since * 1000 < cutoffMs;
    if (!isOldOrUnknown) return false;

    if (!args.anyStatus && f.presence?.status !== 'offline') return false;

    if (!args.allowCommonOrg && (f.common_communities?.length ?? 0) > 0) return false;

    return true;
  });
}

async function main() {
  const friends = JSON.parse(fs.readFileSync('friends.json', 'utf8'));

  let args = parseArgs(process.argv.slice(2));
  if (!args.months) {
    args = await runMenu();
  }

  const cutoffMs = Date.now() - args.months * 30 * 24 * 60 * 60 * 1000;
  const candidates = applyFilter(friends, args);
  const outFile = args.out || `candidates.${args.months}mo.json`;
  fs.writeFileSync(outFile, JSON.stringify(candidates, null, 2));

  console.log(`\nSeuil: inactif depuis plus de ${args.months} mois (avant ${new Date(cutoffMs).toISOString().slice(0, 10)})`);
  console.log(`Filtres additionnels: statut=${args.anyStatus ? 'any' : 'offline uniquement'}, org commune=${args.allowCommonOrg ? 'autorisée' : 'aucune exigée'}`);
  console.log(`${candidates.length} / ${friends.length} amis candidats -> ${outFile}`);

  const withNullSince = candidates.filter((f) => f.presence?.since == null).length;
  console.log(`  dont ${withNullSince} avec presence.since inconnu (null)`);
}

main();
