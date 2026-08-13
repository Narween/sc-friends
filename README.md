*[Version française](README.fr.md)*

<a href="https://ko-fi.com/narween"><img src="https://storage.ko-fi.com/cdn/kofi3.png?v=3" height="32" alt="ko-fi"></a>
*Free tool, made on my own time — a coffee is always appreciated.*

# sc-friends

**Clean up your [Spectrum](https://robertsspaceindustries.com/spectrum) friends list**
(the community hub for Star Citizen / Roberts Space Industries): see who's
been inactive and for how long, decide at your own pace who to keep or
remove, then actually apply the removals with one click — no more doing it
one by one by hand in Spectrum's UI.

What it does, concretely:
1. **Fetches** your complete friends list (name, last seen, common orgs...)
2. **Displays it** in a sortable/filterable table (web interface or desktop app)
3. **Lets you decide** who to keep and who to remove — locally, no impact on your real account at this stage
4. **Applies** the chosen removals on Spectrum for real, only once you explicitly confirm

The web interface adds more on top — connection history, main org, CSV
export, auto-refresh... see [Beyond the basics](#local-web-interface-serverjs)
below.

📥 The easiest way to use it: **[download the desktop app](https://github.com/Narween/sc-friends/releases/latest)**
(Windows/macOS/Linux, no technical setup required). A command-line usage is
also available, see below.

Every decision (who stays, who goes) is made **locally in a SQLite
database** before anything is applied to your real account. Nothing gets
removed on the site without explicit confirmation.

## Why

Spectrum doesn't offer any tool to sort/clean up a friends list in bulk
(e.g. removing accounts that have been inactive for a long time). These
scripts replay the internal API (`/api/spectrum/...`), discovered by
intercepting the site's network traffic, to make that cleanup possible
outside the UI.

Two ways to use it: from the command line (below), or as a real desktop app
with a graphical interface (see [Desktop app
(Electron)](#desktop-app-electron) further down) — both share the same code
and the same SQLite database.

## Prerequisites (CLI usage)

```bash
npm install
npx playwright install chromium
```

SQLite is handled via `better-sqlite3` (a native module) — no need to
install a separate `sqlite3` binary.

## Workflow

### 1. Login (`login.js`)

Opens a real Chromium browser (not headless — you need to see the screen to
log in, 2FA included) and saves the session to `auth.json` once logged in.

```bash
node login.js
```

`auth.json` contains session cookies: **never commit it**, it's already in
`.gitignore`.

If you run this on a machine with no screen (remote server, container),
you'll need remote display (X11 forwarding or VNC) to see the window and
log in by hand. The script waits for a signal file
(`.login-done.signal`) instead of an Enter keypress, so it can be driven
remotely.

### 2. Fetch the friends list (`fetch-friends.js`)

```bash
node fetch-friends.js
```

Reloads `auth.json`, replays the Spectrum app's load in headless mode, and
captures the response of `POST /api/spectrum/auth/identify` — which already
contains the complete friends list (`data.friends`), no API-side pagination.
Writes the raw array to `friends.json`.

### 3. Import into the local database (`import-friends.js`)

```bash
node import-friends.js
```

Loads `friends.json` into `friends.db` (SQLite). Upsert: re-running this
script after a new fetch refreshes the data (presence, avatar...) without
ever overwriting a decision already made (the `decision` column).

`friends` table schema:

| column | content |
|---|---|
| `id` | Spectrum identifier (primary key) |
| `nickname`, `displayname`, `avatar` | displayed info |
| `presence_status`, `presence_since` | presence status and Unix timestamp of its last change |
| `common_communities_count` | number of orgs/communities in common |
| `org_name`, `org_url`, `org_redacted` | main organization (parsed from Spectrum's badge list — see below), its URL, and whether it's hidden (privacy) |
| `raw_json` | full raw friend object, for reference |
| `notes` | free-text note, set from the web interface, included in search |
| `tags` | comma-separated free-text tags ("org mate,streamer"), set from the web interface, included in search and filterable |
| `decision` | `NULL` (undecided) / `'keep'` / `'remove'` — **the only field that matters for step 5** |
| `decided_at`, `applied_at`, `apply_success`, `apply_response` | audit trail |

A separate `change_log` table records every observed change (presence
status, nickname, display name) at each import — the web interface's
per-friend 🕒 button and the global activity feed both read from it (see
below). Not real-time: granularity depends on how often you fetch/import,
manually or via auto-refresh.

> Upgrading from v1.0.11? That version briefly shipped a presence-only
> `presence_log` table. It's migrated automatically into `change_log` (same
> rows, `field='presence'`) the first time you run a newer version — nothing
> to do manually, and no history is lost.

**Main organization**: extracted from Spectrum's `meta.badges` (the badge
whose URL contains `/orgs/` is the org; there's at most one). Two edge cases
worth knowing: a friend can genuinely belong to an org literally named
"REDACTED" (has a real URL, not a privacy setting), which is why detection
keys off the URL, not the badge text; and a friend with organization
visibility set to private shows a `[REDACTED]` badge with **no** URL — that
one is reported as "hidden", distinctly from having no org at all.
Spectrum's org names sometimes come back with literal, undecoded HTML
entities (`L'ARM&Eacute;E...` instead of `L'ARMÉE...`) — decoded on import
via the `he` package, otherwise the page's own HTML-escaping would
double-escape the stray `&` and show the raw entity code instead of the
accented character.

### 4. Decide (`mark-candidates.js`) — 100% local, no network calls

```bash
# Mark friends offline for more than 6 months, with no common org, as 'remove'
node mark-candidates.js --months 6

# Options:
node mark-candidates.js --months 6 --any-status        # don't require 'offline' status
node mark-candidates.js --months 6 --allow-common-org   # don't require zero common orgs

# Undo before applying anything:
node mark-candidates.js --reset                # resets everything to NULL (except already-applied friends)
node mark-candidates.js --keep <id>             # forces a specific friend to 'keep'
```

### Local web interface (`server.js`)

A visual alternative to everything above: a small web app (search, filters,
sorting, per-friend or bulk-filtered decisions), directly connected to
`friends.db`. Available in French and English (switcher top-right), with a
light/dark/system theme. The app version is shown in the window title and in
the page header.

Beyond the basics:
- **Nicknames link to the RSI citizen profile**
  (`robertsspaceindustries.com/citizens/<nickname>`) — click through to check
  a friend's profile before deciding.
- **Main organization** shown under the name, clickable when public. Shows
  "hidden (private)" explicitly when the friend has set their org visibility
  to private on RSI — distinct from having no org at all, which shows
  nothing.
- **Connection history**: the 🕒 button next to a friend's status opens the
  recorded status/nickname/display-name changes for that friend (up to the
  last 50), a bit like VRCX's friend log. Populated by `change_log` (see the
  schema above) — only as fine-grained as how often the data gets
  refreshed.
- **Activity feed** (📰 button, header): the same `change_log` data, but
  merged across every friend into one chronological feed instead of opening
  the history popup one friend at a time.
- **Tags**: free-text, comma-separated, per friend (e.g. "org mate,
  streamer") — filterable via the toolbar dropdown, included in search,
  exported in the CSV. Multi-word tags are supported; matching is
  case-sensitive and exact per tag (a "org" tag won't match "reorganized").
- **Auto-refresh**: in the setup panel, an optional toggle re-runs fetch +
  import on a timer (15 min to once a day) without touching anything
  manually — useful together with connection history, so it actually has
  something to log. Requires a saved session (`auth.json`); never opens the
  login browser on its own. Deliberately capped at a 5-minute minimum: this
  drives a real Playwright browser against Spectrum, and hammering it every
  few seconds would look like scraping abuse, not to mention friend presence
  doesn't change that fast anyway.
- **Per-friend notes**, free text, auto-saved (debounced) as you type,
  included in the search box alongside nickname/display name.
- **Filters**: decision, presence status, "has a note", and "possible
  duplicates" (friends sharing the same display name under different
  handles — catches an account that changed its RSI handle).
- **Keyboard shortcuts**: with the mouse over a row, `K`/`R`/`U` set that
  friend's decision to Keep/Remove/Undecided without reaching for a button —
  inert while typing in a text field.
- **CSV export** of the currently filtered list (nickname, display name,
  status, last seen, common orgs, decision, notes) — for reviewing or
  sharing a "to remove" list outside the app.
- **Database backup**: downloads a consistent snapshot of `friends.db`
  (uses `better-sqlite3`'s own online-backup API, safe even with pending WAL
  writes — a raw file copy wouldn't be).
- Pagination controls (page size, prev/next) are duplicated above and below
  the table.

```bash
node server.js
```

The server only listens locally (`127.0.0.1:3939`). From another machine,
open an SSH tunnel then go to `http://localhost:3939`:

```bash
ssh -L 3939:localhost:3939 <user>@<host>
```

The **⚙ Populate database** button gives access to a panel that directly
runs `login.js` / `fetch-friends.js` / `import-friends.js` (with each one's
live log) — no separate terminal needed for these steps. For the login step,
a **✅ I'm logged in** button appears once the Chromium window is open;
click it once you're actually logged in to trigger saving `auth.json`.

The red banner at the bottom of the page lets you trigger the **real
deletion** (equivalent to `apply-removals.js --confirm`) directly from the
page: the button stays disabled until you type `YES` (`OUI` in French) in
the confirmation field, and one more confirmation is asked before it runs.
The deletion log streams live. While it's running, a pulsing banner appears
and decisions/notes/bulk actions are locked (grayed out, unclickable) —
`apply-removals.js` snapshots the pending list once at the start, so editing
decisions mid-run would just be confusing, not actually reflected in that
run.

You can also edit `friends.db` directly in SQL to fine-tune things:

```bash
sqlite3 friends.db "UPDATE friends SET decision='keep' WHERE nickname LIKE '%nick%';"
sqlite3 friends.db "SELECT nickname, presence_status, presence_since FROM friends WHERE decision='remove';"
```

### 5. Real application (`apply-removals.js`)

```bash
# Dry-run by default: lists what WOULD be removed, no network call
node apply-removals.js

# Actually executes the removals marked 'remove'
node apply-removals.js --confirm
```

Replays `POST /api/spectrum/friend/remove` for each friend marked `remove`,
with a 1.5s pause between each call. Every processed row is marked
`applied_at` immediately: an interrupted run can be restarted without risk
of redoing removals already done.

## Desktop app (Electron)

The same tool, packaged as a real desktop app (`.exe` / `.dmg` /
`.AppImage`) — double-click, native window, no terminal required. Data
(`auth.json`, `friends.json`, `friends.db`) lives in the system's standard
config directory (`%APPDATA%` on Windows, `~/Library/Application Support` on
macOS, `~/.config` on Linux), not in the install directory.

**Auto-update (Windows/Linux only)**: on launch, the app checks the GitHub
Releases feed via `electron-updater` and installs newer versions in the
background, with a system notification once ready. **Not available on
macOS** — Squirrel.Mac (Electron's macOS update mechanism) requires a
code-signed app, which this project doesn't have (see the unsigned-installer
note below); Mac users update manually via the Releases page, same as
before.

### Download an installer (recommended)

👉 **[Latest version in the Releases tab](https://github.com/Narween/sc-friends/releases/latest)**
— one file per platform (`.exe` Windows, `.dmg` macOS, `.AppImage` Linux),
built automatically by GitHub Actions on real Windows/macOS/Linux runners
(no cross-compilation).

> ⚠️ **These installers are not signed** (no code-signing certificate — that
> costs several hundred euros/year, out of budget for a personal tool). Your
> OS will therefore warn you on first launch. That's expected, not a sign of
> malware: the code is public, you can read it or rebuild it yourself if you
> prefer (see below).

**Windows**: Defender SmartScreen blocks execution the first time. Click
**"More info"** then **"Run anyway"**.

**macOS**: Gatekeeper refuses to open a non-notarized app with a simple
click. Open the `.dmg`, drag the app into *Applications*, then **right-click
→ Open** (not a double-click) and confirm in the dialog. Only needed on
first launch. The macOS build is **Apple Silicon (arm64) only** — no Intel
build for now.

**Linux**: make the AppImage executable before running it:
```bash
chmod +x SC.Friends-*.AppImage
./SC.Friends-*.AppImage
```

To rebuild a build yourself (e.g. to verify it matches the source code), see
the following sections.

### Build from source via Actions

From the repo's **Actions** tab, you can also trigger the workflow manually
(`workflow_dispatch`) on any branch/commit, without needing a version tag —
useful to test a change before publishing a release.

### Run in development mode

```bash
npm install
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
npm run electron
```

`npm run electron` first rebuilds `better-sqlite3` for Electron's ABI
(`electron-builder install-app-deps`), then launches the app.

### Build the installer yourself

```bash
npm run dist
```

Produces an installer for the current platform in `dist-electron/`.

### ⚠ Local gotcha: two different native ABIs

`better-sqlite3` is a native module compiled for a specific runtime version.
Electron bundles its own Node (different ABI from the system Node). On the
same dev machine, if you switch between CLI usage (`node server.js`, `node
apply-removals.js`...) and Electron (`npm run electron`), you need to
rebuild in between:

```bash
npm rebuild better-sqlite3          # back to the system Node ABI (for CLI)
npx electron-builder install-app-deps   # back to the Electron ABI
```

An end user never has to worry about this: the packaged installer already
bundles the right binary, and CI (Node 22 in `build.yml`) handles it
automatically on every build.

## Translating the app (i18n)

All translatable strings — web interface and CLI script messages — live in
`i18n/<code>.json` (one file per language, same keys everywhere). No code
change is needed to add a language:

1. Copy `i18n/en.json` to `i18n/<code>.json` (e.g. `de.json`) and translate
   the values. `{placeholder}` markers (e.g. `{count}`, `{file}`) must stay
   as-is — they're substituted at display time.
2. Fill in `"langName"` (the language name shown in the switcher).
3. That's it: the web interface detects the file via `GET /api/languages`
   and automatically adds a button for the new language; CLI scripts pick it
   up via `SC_FRIENDS_LANG=<code>`.

Keys prefixed `cli.*` are script messages (`login.js`, `fetch-friends.js`...);
the rest are the web interface (`public/index.html`).

### Proposing a translation (pull request)

1. Fork the repo, create a branch.
2. Add your `i18n/<code>.json` (copy `i18n/en.json`, translate the values,
   keep keys and `{placeholder}` markers intact).
3. Check that the file is valid JSON (`node -e "require('./i18n/<code>.json')"`
   shouldn't throw) and that every key from `i18n/en.json` is present — a
   quick check:
   ```bash
   node -e "
   const en = require('./i18n/en.json'), x = require('./i18n/<code>.json');
   const missing = Object.keys(en).filter(k => !(k in x));
   console.log(missing.length ? 'Missing keys: ' + missing.join(', ') : 'OK, nothing missing');
   "
   ```
4. Open a pull request. The `main` branch is protected: every PR must be
   reviewed and approved before merging (see [Security /
   sanity](#security--sanity)).

## Other files

- `discover-friends.js` — network-discovery tool used to identify the API
  endpoints (`auth/identify`, `friend/remove`...) by intercepting traffic
  during a manual navigation. Useful if Spectrum changes its API.
- `filter-friends.js` / `remove-friends.js` — first prototype (JSON
  `candidates.Xmo.json` files instead of a SQLite database). Functional but
  superseded by the `import-friends.js` / `mark-candidates.js` /
  `apply-removals.js` workflow above, more convenient for adjusting
  decisions.

## Security / sanity

- `auth.json`, `friends.json`, `friends.db` and the `candidates*.json` /
  `remove-log*.json` files are in `.gitignore`: they contain session data
  and personal data (yours and your friends').
- No removal happens without explicit confirmation.
- The local server (`server.js`) only listens on `127.0.0.1` and checks the
  `Origin`/`Referer` header on state-changing requests, to prevent a
  third-party webpage open in the same browser from triggering actions
  without your knowledge (local CSRF).
- All SQL queries use bound parameters (`?`), never string concatenation.
- Removing a friend is visible on that friend's side — it's not a trivial
  action, hence the multi-step workflow with review before applying.
