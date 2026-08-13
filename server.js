// Petite appli web locale : revue/décision des amis (branchée sur
// friends.db) + pilotage des 4 étapes du pipeline (login, récupération,
// import, suppression réelle) via des boutons, chacun streamant son log en
// direct par SSE. Écoute en local uniquement (127.0.0.1).
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { getDb, getSetting, setSetting } = require('./lib/db');
const { AUTH_FILE, FRIENDS_JSON_FILE, DB_FILE, LOGIN_SIGNAL_FILE } = require('./lib/paths');
const { t, available } = require('./lib/i18n');

const I18N_DIR = path.join(__dirname, 'i18n');

const PORT = Number(process.env.PORT || 3939);
const PUBLIC_DIR = path.join(__dirname, 'public');
const ALLOWED_SORT = ['presence_since', 'nickname', 'displayname', 'common_communities_count', 'applied_at'];
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

const TASKS = {
  login: { script: 'login.js' },
  fetch: { script: 'fetch-friends.js' },
  import: { script: 'import-friends.js' },
  apply: { script: 'apply-removals.js', baseArgs: ['--confirm'] },
};

const taskStates = {};
function getTaskState(name) {
  if (!taskStates[name]) taskStates[name] = { running: false, log: [], exitCode: null, sseClients: new Set() };
  return taskStates[name];
}
function broadcastLine(name, line) {
  const st = getTaskState(name);
  st.log.push(line);
  for (const res of st.sseClients) res.write(`data: ${JSON.stringify(line)}\n\n`);
}
function broadcastDone(name, code) {
  const st = getTaskState(name);
  for (const res of st.sseClients) res.write(`event: done\ndata: ${code}\n\n`);
}

// Pose le verrou "en cours" de façon synchrone, avant le moindre await —
// sinon deux déclenchements presque simultanés (bouton + auto-refresh, ou
// deux boutons) passent tous les deux la vérification `st.running` avant que
// l'un d'eux n'ait eu la chance de poser le verrou (dangereux pour "apply",
// qui pilote un vrai navigateur contre le vrai site).
function lockTask(name) {
  const st = getTaskState(name);
  st.running = true;
  st.log = [];
  st.exitCode = null;
  return st;
}

// Lance effectivement le script (le verrou doit déjà avoir été posé par
// lockTask juste avant). Utilisé à la fois par la route HTTP /api/run/:name
// et par le scheduler d'auto-refresh interne — les deux veulent la même
// mécanique de spawn + streaming SSE + résolution du code de sortie.
function runScript(name, body = {}) {
  const st = getTaskState(name);
  const task = TASKS[name];
  const args = [path.join(__dirname, task.script), ...(task.baseArgs || [])];
  if (name === 'apply' && Number.isInteger(body.limit) && body.limit > 0) {
    args.push('--limit', String(body.limit));
  }

  // process.execPath + ELECTRON_RUN_AS_NODE : fonctionne aussi bien en
  // usage CLI pur (execPath = binaire node, la variable est ignorée) que
  // packagé dans Electron (execPath = l'exe de l'appli, qui se comporte
  // alors comme un node autonome pour ce process enfant — pas besoin d'un
  // node système sur la machine de l'utilisateur final).
  // cwd: en packagé, __dirname vit dans app.asar (chemin virtuel) — Windows
  // ne sait pas y faire CreateProcess (ENOENT trompeur, qui nomme
  // l'exécutable alors que c'est le cwd le vrai coupable). Les scripts
  // enfants ne se servent pas du cwd pour localiser leurs fichiers (ils
  // utilisent SC_FRIENDS_DATA_DIR, transmis via env plus bas), donc n'importe
  // quel vrai dossier disque convient ; resourcesPath (posé par main.js
  // uniquement en packagé) en est un, garanti.
  const child = spawn(process.execPath, args, {
    cwd: process.env.SC_FRIENDS_RESOURCES_PATH || __dirname,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      // Langue active côté navigateur, transmise au script pour que ses
      // logs (visibles dans le panneau SSE) parlent la même langue que
      // l'interface plutôt qu'une langue fixée en dur.
      SC_FRIENDS_LANG: available().includes(body.lang) ? body.lang : 'fr',
    },
  });
  const onData = (chunk) => chunk.toString().split('\n').filter(Boolean).forEach((l) => broadcastLine(name, l));
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  return new Promise((resolve) => {
    child.on('close', (code) => {
      st.running = false;
      st.exitCode = code;
      broadcastDone(name, code);
      resolve(code);
    });
    // Si spawn() échoue carrément (exécutable introuvable, permission
    // refusée...), 'close' ne se déclenche jamais : sans ce handler, la
    // tâche restait "en cours" indéfiniment sans jamais rien afficher.
    child.on('error', (spawnErr) => {
      broadcastLine(name, `spawn error: ${spawnErr.message}`);
      st.running = false;
      st.exitCode = -1;
      broadcastDone(name, -1);
      resolve(-1);
    });
  });
}

// Un seul script à la fois pilote un vrai navigateur Playwright contre
// Spectrum (login/fetch/apply — import est pur SQLite mais reste dans le
// même verrou par simplicité). Sans ça, l'auto-refresh pourrait démarrer un
// fetch pendant qu'une vraie suppression (apply) tourne déjà : deux sessions
// Playwright simultanées sur le même compte RSI, exactement le genre de
// comportement qui ressemble à du scraping abusif aux yeux d'une détection
// anti-bot.
function anyTaskRunning(exceptName) {
  return Object.keys(TASKS).some((name) => name !== exceptName && getTaskState(name).running);
}

// --- Auto-refresh : relance fetch puis import à intervalle régulier, sans
// action manuelle. Désactivé par défaut. Nécessite une session déjà
// sauvegardée (auth.json) — jamais d'ouverture automatique du navigateur de
// login, ça resterait toujours un geste explicite.
let autoRefreshTimer = null;

async function runAutoRefresh() {
  if (!fs.existsSync(AUTH_FILE)) return;
  if (anyTaskRunning()) return;
  lockTask('fetch');
  const fetchCode = await runScript('fetch');
  if (fetchCode !== 0) return;
  lockTask('import');
  const importCode = await runScript('import');
  if (importCode === 0) {
    setSetting('last_refresh_at', new Date().toISOString());
  }
}

function scheduleAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  const enabled = getSetting('auto_refresh_enabled', '0') === '1';
  const minutes = Math.max(5, parseInt(getSetting('auto_refresh_interval_minutes', '60'), 10) || 60);
  if (!enabled) return;
  autoRefreshTimer = setInterval(runAutoRefresh, minutes * 60 * 1000);
}

function buildWhere(db_, { search, decision, status, hasNotes, duplicates }) {
  const conditions = [];
  const params = [];
  if (search) {
    conditions.push(`(nickname LIKE ? OR displayname LIKE ? OR notes LIKE ?)`);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (decision === 'keep' || decision === 'remove') {
    conditions.push(`decision=?`);
    params.push(decision);
  } else if (decision === 'undecided') {
    conditions.push(`decision IS NULL`);
  }
  if (status && status !== 'all') {
    conditions.push(`presence_status=?`);
    params.push(status);
  }
  if (hasNotes) {
    conditions.push(`notes IS NOT NULL AND notes != ''`);
  }
  if (duplicates) {
    // Même displayname porté par au moins 2 lignes distinctes : signe
    // possible d'un ami retrouvé sous un nouveau handle (nickname) après un
    // changement de pseudo RSI.
    conditions.push(`displayname IN (SELECT displayname FROM friends GROUP BY displayname HAVING COUNT(*) > 1)`);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}
function serveStatic(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function isTrustedOrigin(req) {
  // Le serveur n'écoute qu'en local, mais rien n'empêche une page web
  // malveillante ouverte dans le même navigateur d'envoyer une requête vers
  // 127.0.0.1:PORT (CSRF "localhost"). Comme cette appli peut déclencher de
  // vraies suppressions d'amis, on vérifie que les requêtes qui modifient
  // l'état viennent bien de notre propre page (Origin/Referer sur notre
  // origine), pas d'un site tiers.
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return true; // requêtes locales sans en-tête (curl, scripts) : pas de navigateur tiers impliqué
  try {
    const originUrl = new URL(origin);
    return (originUrl.hostname === '127.0.0.1' || originUrl.hostname === 'localhost') && originUrl.port === String(PORT);
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && !isTrustedOrigin(req)) {
    return sendJson(res, 403, { error: 'forbidden origin' });
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/languages') {
    const langs = available().map((code) => ({ code, name: t(code, 'langName') }));
    return sendJson(res, 200, langs);
  }

  const i18nMatch = url.pathname.match(/^\/i18n\/([a-z]{2,5})\.json$/);
  if (req.method === 'GET' && i18nMatch && available().includes(i18nMatch[1])) {
    return serveStatic(res, path.join(I18N_DIR, `${i18nMatch[1]}.json`), 'application/json; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/about') {
    return sendJson(res, 200, {
      name: PKG.name,
      productName: 'SC-Friends',
      version: PKG.version,
      description: PKG.description,
      repository: 'https://github.com/Narween/sc-friends',
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/backup') {
    // db.backup() (better-sqlite3's own online-backup API) rather than just
    // streaming DB_FILE directly: with WAL mode on, the on-disk file alone
    // can be missing recently-committed data still sitting in the -wal file,
    // so a raw copy risks a subtly incomplete snapshot.
    const tmpPath = path.join(os.tmpdir(), `sc-friends-backup-${Date.now()}.db`);
    try {
      await getDb().backup(tmpPath);
      const stat = fs.statSync(tmpPath);
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="sc-friends-backup-${stamp}.db"`,
      });
      const stream = fs.createReadStream(tmpPath);
      stream.pipe(res);
      stream.on('close', () => fs.unlink(tmpPath, () => {}));
    } catch (e) {
      fs.unlink(tmpPath, () => {});
      return sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/export.csv') {
    const search = url.searchParams.get('search') || '';
    const decision = url.searchParams.get('decision') || 'all';
    const status = url.searchParams.get('status') || 'all';
    const hasNotes = url.searchParams.get('hasNotes') === '1';
    const duplicates = url.searchParams.get('duplicates') === '1';
    const db = getDb();
    const { where, params } = buildWhere(db, { search, decision, status, hasNotes, duplicates });
    const rows = db
      .prepare(
        `SELECT nickname, displayname, presence_status, presence_since, common_communities_count, org_name, org_redacted, decision, notes
         FROM friends ${where}
         ORDER BY nickname ASC;`
      )
      .all(...params);
    const csvEscape = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['nickname', 'displayname', 'status', 'last_seen', 'common_orgs', 'main_org', 'decision', 'notes'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.nickname, r.displayname, r.presence_status,
        r.presence_since ? new Date(r.presence_since * 1000).toISOString() : '',
        r.common_communities_count, r.org_redacted ? 'hidden/private' : (r.org_name || ''),
        r.decision || 'undecided', r.notes,
      ].map(csvEscape).join(','));
    }
    // BOM en tête : sans lui, Excel devine souvent un mauvais encodage pour
    // les caractères non-ASCII (pseudos accentués/UTF-8) et les affiche mal.
    const body = '﻿' + lines.join('\r\n') + '\r\n';
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="sc-friends-export-${stamp}.csv"`,
    });
    res.end(body);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    function fileInfo(p) {
      try {
        const st = fs.statSync(p);
        return { exists: true, mtime: st.mtime.toISOString() };
      } catch {
        return { exists: false, mtime: null };
      }
    }
    const dbInfo = fileInfo(DB_FILE);
    let dbCount = null;
    if (dbInfo.exists) {
      try {
        dbCount = getDb().prepare('SELECT COUNT(*) as n FROM friends').get().n;
      } catch {
        dbCount = null;
      }
    }
    return sendJson(res, 200, {
      auth: fileInfo(AUTH_FILE),
      friendsJson: fileInfo(FRIENDS_JSON_FILE),
      db: { ...dbInfo, count: dbCount },
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/settings') {
    const minutes = Math.max(5, parseInt(getSetting('auto_refresh_interval_minutes', '60'), 10) || 60);
    const enabled = getSetting('auto_refresh_enabled', '0') === '1';
    const lastRefreshAt = getSetting('last_refresh_at', null);
    return sendJson(res, 200, {
      autoRefreshEnabled: enabled,
      autoRefreshIntervalMinutes: minutes,
      lastRefreshAt,
      nextRefreshAt: enabled && lastRefreshAt
        ? new Date(new Date(lastRefreshAt).getTime() + minutes * 60000).toISOString()
        : null,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/settings') {
    const { autoRefreshEnabled, autoRefreshIntervalMinutes } = await readBody(req);
    if (typeof autoRefreshEnabled !== 'boolean') return sendJson(res, 400, { error: 'invalid autoRefreshEnabled' });
    const minutes = Math.max(5, Math.min(1440, parseInt(autoRefreshIntervalMinutes, 10) || 60));
    setSetting('auto_refresh_enabled', autoRefreshEnabled ? '1' : '0');
    setSetting('auto_refresh_interval_minutes', String(minutes));
    scheduleAutoRefresh();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && /^\/api\/friends\/[^/]+\/history$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/')[3]);
    const rows = getDb()
      .prepare(`SELECT status, changed_at FROM presence_log WHERE friend_id=? ORDER BY changed_at DESC LIMIT 50;`)
      .all(id);
    return sendJson(res, 200, rows);
  }

  if (req.method === 'GET' && url.pathname === '/api/summary') {
    const rows = getDb()
      .prepare(`SELECT COALESCE(decision, 'undecided') as decision, (applied_at IS NOT NULL) as applied, COUNT(*) as n FROM friends GROUP BY decision, applied;`)
      .all();
    return sendJson(res, 200, rows);
  }

  if (req.method === 'GET' && url.pathname === '/api/friends') {
    const search = url.searchParams.get('search') || '';
    const decision = url.searchParams.get('decision') || 'all';
    const status = url.searchParams.get('status') || 'all';
    const hasNotes = url.searchParams.get('hasNotes') === '1';
    const duplicates = url.searchParams.get('duplicates') === '1';
    const sort = ALLOWED_SORT.includes(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'presence_since';
    const order = url.searchParams.get('order') === 'desc' ? 'DESC' : 'ASC';
    const pageSizeRaw = url.searchParams.get('pageSize') || '50';
    // 'all' -> LIMIT -1 (SQLite's own "no limit" syntax) instead of some
    // arbitrarily large number, and there's only ever one page in that case.
    const showAll = pageSizeRaw === 'all';
    const page = showAll ? 1 : Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const pageSize = showAll ? -1 : Math.min(400, Math.max(1, parseInt(pageSizeRaw, 10) || 50));
    const offset = showAll ? 0 : (page - 1) * pageSize;

    const db = getDb();
    const { where, params } = buildWhere(db, { search, decision, status, hasNotes, duplicates });
    const total = db.prepare(`SELECT COUNT(*) as n FROM friends ${where};`).get(...params).n;
    const rows = db
      .prepare(
        `SELECT id, nickname, displayname, avatar, presence_status, presence_since, common_communities_count, org_name, org_url, org_redacted, decision, applied_at, apply_success, notes
         FROM friends ${where}
         ORDER BY ${sort} ${order} NULLS LAST
         LIMIT ? OFFSET ?;`
      )
      .all(...params, pageSize, offset);
    return sendJson(res, 200, { total, page, pageSize, rows });
  }

  if (req.method === 'POST' && /^\/api\/friends\/[^/]+\/decision$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/')[3]);
    const { decision } = await readBody(req);
    if (![null, 'keep', 'remove'].includes(decision)) return sendJson(res, 400, { error: 'invalid decision' });
    getDb()
      .prepare(`UPDATE friends SET decision=?, decided_at=? WHERE id=? AND applied_at IS NULL;`)
      .run(decision, decision === null ? null : new Date().toISOString(), id);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && /^\/api\/friends\/[^/]+\/notes$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/')[3]);
    const { notes } = await readBody(req);
    if (typeof notes !== 'string' || notes.length > 2000) {
      return sendJson(res, 400, { error: 'invalid notes' });
    }
    getDb()
      .prepare(`UPDATE friends SET notes=? WHERE id=?;`)
      .run(notes === '' ? null : notes, id);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/bulk-decision') {
    const { search, decision: filterDecision, status, setTo } = await readBody(req);
    if (![null, 'keep', 'remove'].includes(setTo)) return sendJson(res, 400, { error: 'invalid setTo' });
    const db = getDb();
    const { where, params } = buildWhere(db, { search, decision: filterDecision, status });
    const fullWhere = where ? `${where} AND applied_at IS NULL` : 'WHERE applied_at IS NULL';
    const matched = db.prepare(`SELECT COUNT(*) as n FROM friends ${fullWhere};`).get(...params).n;
    db.prepare(`UPDATE friends SET decision=?, decided_at=? ${fullWhere};`).run(
      setTo,
      setTo === null ? null : new Date().toISOString(),
      ...params
    );
    return sendJson(res, 200, { ok: true, updated: matched });
  }

  if (req.method === 'POST' && url.pathname === '/api/login-confirm') {
    fs.writeFileSync(LOGIN_SIGNAL_FILE, '');
    return sendJson(res, 200, { ok: true });
  }

  const runMatch = url.pathname.match(/^\/api\/run\/([a-z]+)$/);
  if (req.method === 'POST' && runMatch) {
    const name = runMatch[1];
    const task = TASKS[name];
    if (!task) return sendJson(res, 404, { error: 'unknown task' });
    const st = getTaskState(name);
    if (st.running || anyTaskRunning(name)) return sendJson(res, 409, { error: 'already running' });
    lockTask(name);
    const body = await readBody(req);
    runScript(name, body); // fire-and-forget: la progression passe par SSE (/api/run/:name/events)
    return sendJson(res, 200, { started: true });
  }

  const eventsMatch = url.pathname.match(/^\/api\/run\/([a-z]+)\/events$/);
  if (req.method === 'GET' && eventsMatch) {
    const name = eventsMatch[1];
    if (!TASKS[name]) return sendJson(res, 404, { error: 'unknown task' });
    const st = getTaskState(name);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const line of st.log) res.write(`data: ${JSON.stringify(line)}\n\n`);
    if (!st.running && st.exitCode !== null) res.write(`event: done\ndata: ${st.exitCode}\n\n`);
    st.sseClients.add(res);
    req.on('close', () => st.sseClients.delete(res));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// On ne sait pas encore quelle langue l'utilisateur préfère à ce stade (page
// pas encore chargée) : ces deux messages système s'affichent dans TOUTES
// les langues disponibles (boucle sur available(), pas de liste FR/EN codée
// en dur — ajouter une langue dans i18n/ suffit, rien à changer ici).
function allLangs(key, vars) {
  return available()
    .map((code) => t(code, key, vars))
    .join('\n\n');
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const message = allLangs('cli.server.portInUse', { port: PORT });
    // Dans l'appli packagée, la console n'est pas visible (pas de terminal
    // sur Windows) : on affiche une vraie boîte de dialogue native.
    if (process.versions.electron) {
      const { dialog } = require('electron');
      dialog.showErrorBox('SC-Friends', message);
    } else {
      console.error(message);
    }
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(allLangs('cli.server.listening', { port: PORT }));
  console.log(allLangs('cli.server.tunnelHint', { port: PORT }));
  scheduleAutoRefresh();
});
