// Petite appli web locale : revue/décision des amis (branchée sur
// friends.db) + pilotage des 4 étapes du pipeline (login, récupération,
// import, suppression réelle) via des boutons, chacun streamant son log en
// direct par SSE. Écoute en local uniquement (127.0.0.1).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { getDb } = require('./lib/db');
const { AUTH_FILE, FRIENDS_JSON_FILE, DB_FILE, LOGIN_SIGNAL_FILE } = require('./lib/paths');

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

function buildWhere(db_, { search, decision, status }) {
  const conditions = [];
  const params = [];
  if (search) {
    conditions.push(`(nickname LIKE ? OR displayname LIKE ?)`);
    params.push(`%${search}%`, `%${search}%`);
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/about') {
    return sendJson(res, 200, {
      name: PKG.name,
      productName: 'SC Friends',
      version: PKG.version,
      description: PKG.description,
      repository: 'https://github.com/Narween/sc-friends',
    });
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
    const sort = ALLOWED_SORT.includes(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'presence_since';
    const order = url.searchParams.get('order') === 'desc' ? 'DESC' : 'ASC';
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const pageSize = Math.min(200, parseInt(url.searchParams.get('pageSize') || '50', 10));
    const offset = (page - 1) * pageSize;

    const db = getDb();
    const { where, params } = buildWhere(db, { search, decision, status });
    const total = db.prepare(`SELECT COUNT(*) as n FROM friends ${where};`).get(...params).n;
    const rows = db
      .prepare(
        `SELECT id, nickname, displayname, avatar, presence_status, presence_since, common_communities_count, decision, applied_at, apply_success
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

    const body = await readBody(req);
    const args = [path.join(__dirname, task.script), ...(task.baseArgs || [])];
    if (name === 'apply' && Number.isInteger(body.limit) && body.limit > 0) {
      args.push('--limit', String(body.limit));
    }

    st.running = true;
    st.log = [];
    st.exitCode = null;

    // process.execPath + ELECTRON_RUN_AS_NODE : fonctionne aussi bien en
    // usage CLI pur (execPath = binaire node, la variable est ignorée) que
    // packagé dans Electron (execPath = l'exe de l'appli, qui se comporte
    // alors comme un node autonome pour ce process enfant — pas besoin d'un
    // node système sur la machine de l'utilisateur final).
    const child = spawn(process.execPath, args, {
      cwd: __dirname,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    const onData = (chunk) => chunk.toString().split('\n').filter(Boolean).forEach((l) => broadcastLine(name, l));
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      st.running = false;
      st.exitCode = code;
      broadcastDone(name, code);
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

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Le port ${PORT} est déjà utilisé par un autre processus (une autre instance de l'appli, ou un autre programme). Ferme-le puis relance.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Interface locale : http://127.0.0.1:${PORT}`);
  console.log(`Depuis une autre machine : ssh -L ${PORT}:localhost:${PORT} <user>@<host>  puis ouvre http://localhost:${PORT}`);
});
