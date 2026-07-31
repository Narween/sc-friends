# sc-friends

Boîte à outils Playwright + SQLite pour exporter et faire le ménage dans sa
liste d'amis [Spectrum](https://robertsspaceindustries.com/spectrum) (le hub
communautaire de Star Citizen / Roberts Space Industries).

Toute décision (qui reste, qui part) se prend **en local dans une base
SQLite** avant d'appliquer quoi que ce soit sur le vrai compte. Rien n'est
supprimé côté site sans un `--confirm` explicite.

## Pourquoi

Spectrum n'offre aucun outil pour trier/nettoyer une liste d'amis en masse
(ex: retirer les comptes inactifs depuis longtemps). Ces scripts rejouent
l'API interne (`/api/spectrum/...`) découverte en interceptant le trafic
réseau du site, pour permettre ce ménage hors de l'UI.

Deux façons de l'utiliser : en ligne de commande (ci-dessous), ou comme une
vraie appli desktop avec interface graphique (voir [Appli desktop
(Electron)](#appli-desktop-electron) plus bas) — les deux partagent le même
code et la même base SQLite.

## Prérequis (usage CLI)

```bash
npm install
npx playwright install chromium
```

SQLite est géré via `better-sqlite3` (module natif, pas besoin d'installer un
binaire `sqlite3` séparé).

## Workflow

### 1. Connexion (`login.js`)

Ouvre un vrai navigateur Chromium (pas headless — il faut voir l'écran pour
te connecter, 2FA compris) et sauvegarde la session dans `auth.json` une fois
connecté.

```bash
node login.js
```

`auth.json` contient des cookies de session : **ne le commit jamais**, il est
dans `.gitignore`.

Si tu exécutes ça sur une machine sans écran (serveur distant, container),
il te faut un affichage déporté (X11 forwarding ou VNC) pour voir la fenêtre
et te connecter à la main. Le script attend la présence d'un fichier signal
(`.login-done.signal`) plutôt qu'un appui sur Entrée, pour pouvoir être piloté
à distance.

### 2. Récupération de la liste d'amis (`fetch-friends.js`)

```bash
node fetch-friends.js
```

Recharge `auth.json`, rejoue le chargement de l'app Spectrum en headless, et
capture la réponse de `POST /api/spectrum/auth/identify` — qui contient déjà
la liste complète des amis (`data.friends`), sans pagination côté API. Écrit
le tableau brut dans `friends.json`.

### 3. Import en base locale (`import-friends.js`)

```bash
node import-friends.js
```

Charge `friends.json` dans `friends.db` (SQLite). Upsert : relancer ce script
après une nouvelle capture met à jour les infos (présence, avatar...) sans
jamais écraser une décision déjà prise (colonne `decision`).

Schéma de la table `friends` :

| colonne | contenu |
|---|---|
| `id` | identifiant Spectrum (clé primaire) |
| `nickname`, `displayname`, `avatar` | infos affichées |
| `presence_status`, `presence_since` | statut de présence et horodatage Unix du dernier changement |
| `common_communities_count` | nombre d'orgs/communautés en commun |
| `raw_json` | objet ami brut complet, pour référence |
| `decision` | `NULL` (indécis) / `'keep'` / `'remove'` — **le seul champ qui compte pour l'étape 5** |
| `decided_at`, `applied_at`, `apply_success`, `apply_response` | traçabilité |

### 4. Décision (`mark-candidates.js`) — 100% local, aucun appel réseau

```bash
# Marque 'remove' les amis hors-ligne depuis plus de 6 mois, sans org en commun
node mark-candidates.js --months 6

# Options :
node mark-candidates.js --months 6 --any-status        # n'exige pas le statut 'offline'
node mark-candidates.js --months 6 --allow-common-org   # n'exige pas l'absence d'org commune

# Revenir en arrière avant d'appliquer quoi que ce soit :
node mark-candidates.js --reset                # remet tout à NULL (hors amis déjà appliqués)
node mark-candidates.js --keep <id>             # force un ami précis en 'keep'
```

### Interface web locale (`server.js`)

Alternative visuelle à tout ce qui précède : une petite appli web (recherche,
filtres, tri, décision par ami ou par lot filtré), branchée en direct sur
`friends.db`. Disponible en français et en anglais (sélecteur en haut à
droite), avec un thème clair/sombre/système.

```bash
node server.js
```

Le serveur écoute uniquement en local (`127.0.0.1:3939`). Depuis une autre
machine, ouvre un tunnel SSH puis va sur `http://localhost:3939` :

```bash
ssh -L 3939:localhost:3939 <user>@<host>
```

Le bouton **⚙ Remplir la base** donne accès à un panneau qui lance
directement `login.js` / `fetch-friends.js` / `import-friends.js` (avec le
log de chacun en direct) — plus besoin de terminal séparé pour ces étapes.
Pour l'étape de connexion, un bouton **✅ Je suis connecté** apparaît une fois
la fenêtre Chromium ouverte ; clique dessus une fois réellement connecté pour
déclencher la sauvegarde de `auth.json`.

Le bandeau rouge en bas de page permet de lancer la **suppression réelle**
(équivalent de `apply-removals.js --confirm`) directement depuis la page :
le bouton reste désactivé tant que tu n'as pas tapé `OUI` (respectivement
`YES` en anglais) dans le champ de confirmation, et une confirmation
supplémentaire est demandée avant le lancement. Le log de la suppression
s'affiche en direct.

Tu peux aussi éditer `friends.db` directement en SQL pour affiner :

```bash
sqlite3 friends.db "UPDATE friends SET decision='keep' WHERE nickname LIKE '%pseudo%';"
sqlite3 friends.db "SELECT nickname, presence_status, presence_since FROM friends WHERE decision='remove';"
```

### 5. Application réelle (`apply-removals.js`)

```bash
# Dry-run par défaut : liste ce qui SERAIT supprimé, aucun appel réseau
node apply-removals.js

# Exécute réellement les suppressions marquées 'remove'
node apply-removals.js --confirm
```

Rejoue `POST /api/spectrum/friend/remove` pour chaque ami marqué `remove`,
avec une pause de 1,5s entre chaque appel. Chaque ligne traitée est marquée
`applied_at` immédiatement : une exécution interrompue peut être relancée
sans risquer de redoubler les suppressions déjà faites.

## Appli desktop (Electron)

Le même outil, packagé comme une vraie appli desktop (`.exe` / `.dmg` /
`.AppImage`) — double-clic, fenêtre native, aucun terminal requis. Les
données (`auth.json`, `friends.json`, `friends.db`) vivent dans le dossier
de configuration standard du système (`%APPDATA%` sur Windows, `~/Library/
Application Support` sur macOS, `~/.config` sur Linux), pas dans le dossier
d'installation.

### Récupérer un installeur déjà construit

Le workflow GitHub Actions (`.github/workflows/build.yml`) compile
automatiquement les 3 plateformes sur de vrais runners Windows/macOS/Linux
(pas de cross-compilation locale). Depuis l'onglet **Actions** du repo,
lance le workflow manuellement (`workflow_dispatch`) ou pousse un tag
`vX.Y.Z`, puis télécharge l'artefact correspondant à ton OS.

### Lancer en mode développement

```bash
npm install
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
npm run electron
```

`npm run electron` reconstruit d'abord `better-sqlite3` pour l'ABI
d'Electron (`electron-builder install-app-deps`), puis lance l'appli.

### Construire l'installeur soi-même

```bash
npm run dist
```

Produit un installeur pour la plateforme courante dans `dist-electron/`.

### ⚠ Piège local : deux ABI natives différentes

`better-sqlite3` est un module natif compilé pour une version précise du
runtime. Electron embarque son propre Node (ABI différente du Node système).
Sur une même machine de dev, si tu alternes entre usage CLI (`node
server.js`, `node apply-removals.js`...) et Electron (`npm run electron`),
il faut recompiler entre les deux :

```bash
npm rebuild better-sqlite3          # revenir à l'ABI Node système (pour le CLI)
npx electron-builder install-app-deps   # repasser à l'ABI Electron
```

Un utilisateur final n'a jamais à s'en soucier : l'installeur packagé
embarque déjà le bon binaire, et le CI (Node 22 dans `build.yml`) gère ça
automatiquement à chaque build.

## Traduire l'appli (i18n)

Toutes les chaînes traduisibles — interface web et messages des scripts CLI —
vivent dans `i18n/<code>.json` (un fichier par langue, mêmes clés partout).
Aucune modification de code n'est nécessaire pour ajouter une langue :

1. Copie `i18n/en.json` vers `i18n/<code>.json` (ex: `de.json`) et traduis les
   valeurs. Les `{placeholder}` (ex: `{count}`, `{file}`) doivent rester tels
   quels — ils sont substitués au moment de l'affichage.
2. Renseigne `"langName"` (le nom de la langue affiché dans le sélecteur).
3. C'est tout : l'interface web détecte le fichier via `GET /api/languages`
   et ajoute automatiquement un bouton pour la nouvelle langue ; les scripts
   CLI la reconnaissent via `SC_FRIENDS_LANG=<code>`.

Les clés préfixées `cli.*` sont les messages des scripts (`login.js`,
`fetch-friends.js`...) ; les autres sont l'interface web (`public/index.html`).

## Fichiers annexes

- `discover-friends.js` — outil de découverte réseau utilisé pour identifier
  les endpoints API (`auth/identify`, `friend/remove`...) en interceptant le
  trafic pendant une navigation manuelle. Utile si Spectrum change son API.
- `filter-friends.js` / `remove-friends.js` — premier prototype (fichiers
  JSON `candidates.Xmo.json` au lieu d'une base SQLite). Fonctionnel mais
  remplacé par le workflow `import-friends.js` / `mark-candidates.js` /
  `apply-removals.js` ci-dessus, plus pratique pour ajuster les décisions.

## Sécurité / bon sens

- `auth.json`, `friends.json`, `friends.db` et les fichiers `candidates*.json`
  / `remove-log*.json` sont dans `.gitignore` : ils contiennent des données de
  session et des données personnelles (les tiennes et celles de tes amis).
- Aucune suppression n'a lieu sans `--confirm` explicite.
- Le serveur local (`server.js`) n'écoute que sur `127.0.0.1` et vérifie
  l'en-tête `Origin`/`Referer` sur les requêtes qui modifient l'état, pour
  éviter qu'une page web tierce ouverte dans le même navigateur ne déclenche
  des actions à ton insu (CSRF local).
- Toutes les requêtes SQL utilisent des paramètres liés (`?`), jamais de
  concaténation de chaînes.
- Le retrait d'un ami est visible côté ami concerné — ce n'est pas anodin,
  d'où le workflow en plusieurs étapes avec relecture avant application.
