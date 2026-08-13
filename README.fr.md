*[English version](README.md)*

# sc-friends

**Fait le ménage dans ta liste d'amis [Spectrum](https://robertsspaceindustries.com/spectrum)**
(le hub communautaire de Star Citizen / Roberts Space Industries) : vois qui
n'est plus actif depuis quand, décide tranquillement qui garder ou retirer,
puis applique réellement les retraits en un clic — sans jamais devoir faire
ça un par un à la main dans l'UI de Spectrum.

Ce que ça fait, concrètement :
1. **Récupère** ta liste d'amis complète (nom, dernière connexion, orgs en commun...)
2. **Affiche-la** dans un tableau triable/filtrable (interface web ou appli desktop)
3. **Laisse-toi décider** qui garder et qui retirer — en local, aucun impact sur le vrai compte à ce stade
4. **Applique** réellement les retraits choisis sur Spectrum, seulement quand tu confirmes explicitement

📥 Le plus simple pour l'utiliser : **[télécharger l'appli desktop](https://github.com/Narween/sc-friends/releases/latest)**
(Windows/macOS/Linux, aucune installation technique requise). Un usage en
ligne de commande est aussi possible, voir plus bas.

Toute décision (qui reste, qui part) se prend **en local dans une base
SQLite** avant d'appliquer quoi que ce soit sur le vrai compte. Rien n'est
supprimé côté site sans confirmation explicite.

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
| `notes` | note libre, saisie depuis l'interface web, incluse dans la recherche |
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
droite), avec un thème clair/sombre/système. Le numéro de version s'affiche
dans le titre de la fenêtre et dans l'en-tête de la page.

Au-delà des bases :
- **Le pseudo renvoie vers la fiche RSI**
  (`robertsspaceindustries.com/citizens/<pseudo>`) — pratique pour vérifier
  le profil d'un ami avant de décider.
- **Notes par ami**, texte libre, sauvegardées automatiquement (avec un
  léger délai) pendant la saisie, incluses dans la recherche aux côtés du
  pseudo/nom affiché.
- **Filtres** : décision, statut de présence, "a une note", et "doublons
  possibles" (amis partageant le même nom affiché sous des pseudos
  différents — repère un compte qui a changé de handle RSI).
- **Raccourcis clavier** : souris sur une ligne, `K`/`R`/`U` fixent la
  décision de cet ami sur Garder/Retirer/Indécis sans viser un bouton —
  inactifs pendant la saisie dans un champ texte.
- **Export CSV** de la liste actuellement filtrée (pseudo, nom affiché,
  statut, dernière connexion, orgs communes, décision, notes) — pour relire
  ou partager une liste "à retirer" hors de l'appli.
- **Sauvegarde de la base** : télécharge un instantané cohérent de
  `friends.db` (utilise l'API de backup en ligne de `better-sqlite3`, sûre
  même avec des écritures WAL en attente — une simple copie de fichier ne le
  serait pas).
- Les contrôles de pagination (taille de page, précédent/suivant) sont
  dupliqués au-dessus et en dessous du tableau.

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
s'affiche en direct. Pendant qu'elle tourne, un bandeau qui pulse apparaît
et les décisions/notes/actions groupées sont verrouillées (grisées, non
cliquables) — `apply-removals.js` fige la liste à traiter une seule fois au
démarrage, donc modifier des décisions en cours de route ne serait de toute
façon pas pris en compte pour cette exécution, juste source de confusion.

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

### Télécharger un installeur (recommandé)

👉 **[Dernière version dans l'onglet Releases](https://github.com/Narween/sc-friends/releases/latest)**
— un fichier par plateforme (`.exe` Windows, `.dmg` macOS, `.AppImage`
Linux), compilés automatiquement par GitHub Actions sur de vrais runners
Windows/macOS/Linux (pas de cross-compilation).

> ⚠️ **Ces installeurs ne sont pas signés** (pas de certificat de signature
> de code — ça coûte plusieurs centaines d'euros/an, hors budget d'un outil
> perso). Ton OS va donc t'avertir au premier lancement. C'est normal, pas un
> signe de malware : le code est public, tu peux le relire ou le recompiler
> toi-même si tu préfères (voir plus bas).

**Windows** : Defender SmartScreen bloque l'exécution la première fois.
Clique **"Informations complémentaires"** puis **"Exécuter quand même"**.

**macOS** : Gatekeeper refuse d'ouvrir une app non notariée par un clic
simple. Ouvre le `.dmg`, glisse l'app dans *Applications*, puis fais un
**clic droit → Ouvrir** (pas un double-clic) et confirme dans la boîte de
dialogue. Nécessaire uniquement au premier lancement. Le build macOS est
**Apple Silicon (arm64) uniquement** — pas de build Intel pour l'instant.

**Linux** : rends l'AppImage exécutable avant de la lancer :
```bash
chmod +x SC.Friends-*.AppImage
./SC.Friends-*.AppImage
```

Pour reconstruire toi-même un build (par exemple pour vérifier qu'il
correspond au code source), voir les sections suivantes.

### Compiler depuis les sources via Actions

Depuis l'onglet **Actions** du repo, tu peux aussi lancer le workflow
manuellement (`workflow_dispatch`) sur n'importe quelle branche/commit, sans
passer par un tag de version — utile pour tester une modif avant de publier
une release.

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

### Proposer une traduction (pull request)

1. Fork le repo, crée une branche.
2. Ajoute ton `i18n/<code>.json` (copie `i18n/en.json`, traduis les valeurs,
   garde les clés et les `{placeholder}` intacts).
3. Vérifie que le fichier est un JSON valide (`node -e "require('./i18n/<code>.json')"`
   ne doit pas planter) et que toutes les clés de `i18n/en.json` sont présentes
   — un contrôle rapide :
   ```bash
   node -e "
   const en = require('./i18n/en.json'), x = require('./i18n/<code>.json');
   const missing = Object.keys(en).filter(k => !(k in x));
   console.log(missing.length ? 'Clés manquantes: ' + missing.join(', ') : 'OK, rien ne manque');
   "
   ```
4. Ouvre une pull request. La branche `main` est protégée : toute PR doit
   être relue et approuvée avant merge (voir [Sécurité / bon sens](#sécurité--bon-sens)).

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
