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

## Prérequis

```bash
npm install
npx playwright install chromium
```

Un binaire `sqlite3` doit être disponible dans le `PATH` (déjà présent sur la
plupart des distributions Linux/macOS).

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
- Le retrait d'un ami est visible côté ami concerné — ce n'est pas anodin,
  d'où le workflow en plusieurs étapes avec relecture avant application.
