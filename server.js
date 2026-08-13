// Petite appli web locale : revue/décision des amis (branchée sur
// friends.db) + pilotage des 4 étapes du pipeline (login, récupération,
// import, suppression réelle) via des boutons, chacun streamant son log en
// direct par SSE. Écoute en local uniquement (127.0.0.1).
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { getDb } = require('./lib/db');
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
        `SELECT nickname, displayname, presence_status, presence_since, common_communities_count, decision, notes
         FROM friends ${where}
         ORDER BY nickname ASC;`
      )
      .all(...params);
    const csvEscape = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['nickname', 'displayname', 'status', 'last_seen', 'common_orgs', 'decision', 'notes'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.nickname, r.displayname, r.presence_status,
        r.presence_since ? new Date(r.presence_since * 1000).toISOString() : '',
        r.common_communities_count, r.decision || 'undecided', r.notes,
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
        `SELECT id, nickname, displayname, avatar, presence_status, presence_since, common_communities_count, decision, applied_at, apply_success, notes
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
    if (st.running) return sendJson(res, 409, { error: 'already running' });
    // Posé tout de suite, avant le moindre await : sinon deux requêtes
    // arrivées presque en même temps passent toutes les deux la vérification
    // ci-dessus avant que l'une d'elles n'ait eu la chance de poser le
    // verrou, et on se retrouve avec deux exécutions concurrentes de la même
    // tâche (dangereux pour "apply", qui pilote un vrai navigateur contre le
    // vrai site).
    st.running = true;
    st.log = [];
    st.exitCode = null;

    const body = await readBody(req);
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
    child.on('close', (code) => {
      st.running = false;
      st.exitCode = code;
      broadcastDone(name, code);
    });
    // Si spawn() échoue carrément (exécutable introuvable, permission
    // refusée...), 'close' ne se déclenche jamais : sans ce handler, la
    // tâche restait "en cours" indéfiniment sans jamais rien afficher.
    child.on('error', (spawnErr) => {
      broadcastLine(name, `spawn error: ${spawnErr.message}`);
      st.running = false;
      st.exitCode = -1;
      broadcastDone(name, -1);
    });

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
});
