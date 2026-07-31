// Petite appli web locale pour revoir/décider en direct des amis à garder ou
// retirer, branchée sur friends.db. Ne fait AUCUN appel réseau vers
// Spectrum : elle ne touche que la colonne `decision` de la base locale.
// La suppression réelle reste une action volontaire en ligne de commande
// (apply-removals.js --confirm), pas un bouton dans cette interface.
//
// Écoute en local uniquement (127.0.0.1) : à atteindre via un tunnel SSH
// (ssh -L 3939:localhost:3939 ...) puis http://localhost:3939 dans le
// navigateur.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const DB = process.env.FRIENDS_DB || 'friends.db';
const PORT = Number(process.env.PORT || 3939);
const PUBLIC_DIR = path.join(__dirname, 'public');
const ALLOWED_SORT = ['presence_since', 'nickname', 'displayname', 'common_communities_count', 'applied_at'];

// État du run de suppression réelle en cours (au plus un à la fois).
const applyState = { running: false, log: [], exitCode: null, sseClients: new Set() };

function applyStateBroadcast(line) {
  applyState.log.push(line);
  for (const res of applyState.sseClients) res.write(`data: ${JSON.stringify(line)}\n\n`);
}
function applyStateBroadcastDone(code) {
  for (const res of applyState.sseClients) res.write(`event: done\ndata: ${code}\n\n`);
}

function esc(v) {
  return String(v).replace(/'/g, "''");
}
function sqlJson(statement) {
  const out = execFileSync('sqlite3', [DB, '.mode json', statement]).toString().trim();
  return out ? JSON.parse(out) : [];
}
function sqlExec(statement) {
  execFileSync('sqlite3', [DB, statement]);
}

function buildWhere({ search, decision, status }) {
  const conditions = [];
  if (search) {
    const s = esc(search);
    conditions.push(`(nickname LIKE '%${s}%' OR displayname LIKE '%${s}%')`);
  }
  if (decision === 'keep' || decision === 'remove') conditions.push(`decision='${decision}'`);
  else if (decision === 'undecided') conditions.push(`decision IS NULL`);
  if (status && status !== 'all') conditions.push(`presence_status='${esc(status)}'`);
  return conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
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

  if (req.method === 'GET' && url.pathname === '/api/summary') {
    const rows = sqlJson(
      `SELECT COALESCE(decision, 'undecided') as decision, (applied_at IS NOT NULL) as applied, COUNT(*) as n FROM friends GROUP BY decision, applied;`
    );
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

    const where = buildWhere({ search, decision, status });
    const total = sqlJson(`SELECT COUNT(*) as n FROM friends ${where};`)[0].n;
    const rows = sqlJson(
      `SELECT id, nickname, displayname, avatar, presence_status, presence_since, common_communities_count, decision, applied_at, apply_success
       FROM friends ${where}
       ORDER BY ${sort} ${order} NULLS LAST
       LIMIT ${pageSize} OFFSET ${offset};`
    );
    return sendJson(res, 200, { total, page, pageSize, rows });
  }

  if (req.method === 'POST' && /^\/api\/friends\/[^/]+\/decision$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/')[3]);
    const { decision } = await readBody(req);
    if (![null, 'keep', 'remove'].includes(decision)) return sendJson(res, 400, { error: 'invalid decision' });
    const decVal = decision === null ? 'NULL' : `'${esc(decision)}'`;
    const decidedAt = decision === null ? 'NULL' : 'CURRENT_TIMESTAMP';
    sqlExec(`UPDATE friends SET decision=${decVal}, decided_at=${decidedAt} WHERE id='${esc(id)}' AND applied_at IS NULL;`);
    return sendJson(res, 200, { ok: true });
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
    const dbInfo = fileInfo(DB);
    let dbCount = null;
    if (dbInfo.exists) {
      try {
        dbCount = sqlJson(`SELECT COUNT(*) as n FROM friends;`)[0].n;
      } catch {
        dbCount = null;
      }
    }
    return sendJson(res, 200, {
      auth: fileInfo('auth.json'),
      friendsJson: fileInfo('friends.json'),
      db: { ...dbInfo, count: dbCount },
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/apply-run') {
    if (applyState.running) return sendJson(res, 409, { error: 'already running' });
    const { limit } = await readBody(req);

    applyState.running = true;
    applyState.log = [];
    applyState.exitCode = null;

    const cliArgs = ['apply-removals.js', '--confirm'];
    if (Number.isInteger(limit) && limit > 0) cliArgs.push('--limit', String(limit));

    const child = spawn('node', cliArgs, { cwd: __dirname });
    const onData = (chunk) => {
      chunk.toString().split('\n').filter(Boolean).forEach(applyStateBroadcast);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      applyState.running = false;
      applyState.exitCode = code;
      applyStateBroadcastDone(code);
    });

    return sendJson(res, 200, { started: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/apply-events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(`--- ${applyState.running ? 'run en cours' : 'dernier run'} (${applyState.log.length} ligne(s) déjà loguées) ---`)}\n\n`);
    for (const line of applyState.log) res.write(`data: ${JSON.stringify(line)}\n\n`);
    if (!applyState.running && applyState.exitCode !== null) {
      res.write(`event: done\ndata: ${applyState.exitCode}\n\n`);
    }
    applyState.sseClients.add(res);
    req.on('close', () => applyState.sseClients.delete(res));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/bulk-decision') {
    const { search, decision: filterDecision, status, setTo } = await readBody(req);
    if (![null, 'keep', 'remove'].includes(setTo)) return sendJson(res, 400, { error: 'invalid setTo' });
    const where = buildWhere({ search, decision: filterDecision, status });
    const fullWhere = where ? `${where} AND applied_at IS NULL` : 'WHERE applied_at IS NULL';
    const matched = sqlJson(`SELECT COUNT(*) as n FROM friends ${fullWhere};`)[0].n;
    const setVal = setTo === null ? 'NULL' : `'${esc(setTo)}'`;
    const decidedAt = setTo === null ? 'NULL' : 'CURRENT_TIMESTAMP';
    sqlExec(`UPDATE friends SET decision=${setVal}, decided_at=${decidedAt} ${fullWhere};`);
    return sendJson(res, 200, { ok: true, updated: matched });
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Interface locale : http://127.0.0.1:${PORT}`);
  console.log(`Depuis ta machine : ssh -L ${PORT}:localhost:${PORT} <user>@<host>  puis ouvre http://localhost:${PORT}`);
});
