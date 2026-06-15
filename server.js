'use strict';
/* PDFノート 共同編集サーバー
 * - 静的ファイル配信
 * - POST /api/share        : 共有ルーム作成(PDF+注釈を保存、共有コードを返す)
 * - GET  /api/share/:code  : ルームの文書を取得(参加時)
 * - WS   /ws?code=XXXXXX   : 注釈操作のリアルタイム同期
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8741;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8'
};

/* ---- ユーザー・セッション管理 ---- */
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const users = new Map();    // username -> {username, salt, hash}
const sessions = new Map(); // token -> {username, created}

try {
  for (const u of JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))) users.set(u.username, u);
} catch {}
try {
  for (const [t, s] of JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))) sessions.set(t, s);
} catch {}
console.log(`${users.size} 人のユーザーを復元しました`);

function saveUsers() {
  fs.writeFile(USERS_FILE, JSON.stringify([...users.values()]), (e) => { if (e) console.error(e.message); });
}
function saveSessions() {
  fs.writeFile(SESSIONS_FILE, JSON.stringify([...sessions.entries()]), (e) => { if (e) console.error(e.message); });
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function createSession(username) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username, created: Date.now() });
  saveSessions();
  return token;
}
function getAuthUser(req, url) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (url && url.searchParams.get('token')) || '';
  const sess = sessions.get(token);
  return sess ? sess.username : null;
}

/* ---- ルーム管理 ----
 * ルーム = タイトル(フォルダ)単位。docs に複数の文書を持つ。
 * room: {code, name, owner, docs: {docId: {name, pdf(base64), annotations}}, clients:Set<ws>, saveTimer}
 */
const rooms = new Map();

for (const f of fs.readdirSync(DATA_DIR)) {
  if (!f.endsWith('.json') || f === 'users.json' || f === 'sessions.json') continue;
  try {
    const r = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
    // 旧形式(文書1つ)からの移行
    if (r.pdf && !r.docs) {
      r.docs = { doc_legacy: { name: r.name, pdf: r.pdf, annotations: r.annotations || {} } };
      delete r.pdf;
      delete r.annotations;
    }
    rooms.set(r.code, { ...r, clients: new Set(), saveTimer: null });
  } catch (e) {
    console.error('ルーム読み込み失敗:', f, e.message);
  }
}
console.log(`${rooms.size} 件の共有ルームを復元しました`);

function persistRoom(room) {
  clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => {
    const { clients, saveTimer, ...data } = room;
    data.updatedAt = Date.now();
    fs.writeFile(path.join(DATA_DIR, room.code + '.json'), JSON.stringify(data), (err) => {
      if (err) console.error('保存失敗:', room.code, err.message);
    });
  }, 800);
}

function newCode() {
  let code;
  do {
    code = crypto.randomInt(0, 36 ** 6).toString(36).toUpperCase().padStart(6, '0');
  } while (rooms.has(code));
  return code;
}

function applyOp(room, docId, page, op) {
  const doc = room.docs[docId];
  if (!doc) return false;
  if (!doc.annotations[page]) doc.annotations[page] = { strokes: [], texts: [] };
  if (op.kind === 'stroke:add') doc.annotations[page].strokes.push(op.stroke);
  else if (op.kind === 'page:set') doc.annotations[page] = op.ann;
  else return false;
  persistRoom(room);
  return true;
}

function broadcast(room, msg, except) {
  const json = JSON.stringify(msg);
  for (const c of room.clients) {
    if (c !== except && c.readyState === 1) c.send(json);
  }
}

/* ---- HTTP ---- */
function readBody(req, limit = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ---- 認証API ----
  if (req.method === 'POST' && (url.pathname === '/api/register' || url.pathname === '/api/login')) {
    try {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!/^[^\s]{1,20}$/.test(username)) return sendJson(res, 400, { error: 'ユーザー名は空白なし20文字以内で入力してください' });
      if (password.length < 4) return sendJson(res, 400, { error: 'パスワードは4文字以上にしてください' });

      if (url.pathname === '/api/register') {
        if (users.has(username)) return sendJson(res, 409, { error: 'このユーザー名は使われています' });
        const salt = crypto.randomBytes(16).toString('hex');
        users.set(username, { username, salt, hash: hashPassword(password, salt) });
        saveUsers();
        console.log('ユーザー登録:', username);
        return sendJson(res, 200, { token: createSession(username), username });
      }
      // ログイン
      const user = users.get(username);
      if (!user) return sendJson(res, 401, { error: 'ユーザー名かパスワードが違います' });
      const calc = Buffer.from(hashPassword(password, user.salt), 'hex');
      const stored = Buffer.from(user.hash, 'hex');
      if (calc.length !== stored.length || !crypto.timingSafeEqual(calc, stored)) {
        return sendJson(res, 401, { error: 'ユーザー名かパスワードが違います' });
      }
      return sendJson(res, 200, { token: createSession(username), username });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/me') {
    const user = getAuthUser(req, url);
    if (!user) return sendJson(res, 401, { error: '未ログイン' });
    return sendJson(res, 200, { username: user });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const h = req.headers['authorization'] || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (sessions.delete(token)) saveSessions();
    return sendJson(res, 200, { ok: true });
  }

  // ---- 共有API(要ログイン) ----
  // 共有ルーム作成(タイトル単位・複数文書)
  if (req.method === 'POST' && url.pathname === '/api/share') {
    const user = getAuthUser(req, url);
    if (!user) return sendJson(res, 401, { error: 'ログインが必要です' });
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      if (!Array.isArray(body.docs) || body.docs.length === 0) return sendJson(res, 400, { error: '文書がありません' });
      const docs = {};
      for (const d of body.docs) {
        if (!d.id || typeof d.pdf !== 'string') return sendJson(res, 400, { error: '文書データが不正です' });
        docs[d.id] = { name: String(d.name || '無題'), pdf: d.pdf, annotations: d.annotations || {} };
      }
      const room = {
        code: newCode(),
        name: String(body.name || '無題'),
        owner: user,
        docs,
        clients: new Set(),
        saveTimer: null
      };
      rooms.set(room.code, room);
      persistRoom(room);
      console.log('ルーム作成:', room.code, room.name, `(${body.docs.length}文書)`);
      return sendJson(res, 200, { code: room.code });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 共有中のタイトルへ文書を追加
  const mAdd = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{6})\/docs$/);
  if (req.method === 'POST' && mAdd) {
    const user = getAuthUser(req, url);
    if (!user) return sendJson(res, 401, { error: 'ログインが必要です' });
    const room = rooms.get(mAdd[1].toUpperCase());
    if (!room) return sendJson(res, 404, { error: '共有コードが見つかりません' });
    try {
      const d = JSON.parse((await readBody(req)).toString('utf8'));
      if (!d.id || typeof d.pdf !== 'string') return sendJson(res, 400, { error: '文書データが不正です' });
      room.docs[d.id] = { name: String(d.name || '無題'), pdf: d.pdf, annotations: d.annotations || {} };
      persistRoom(room);
      broadcast(room, { type: 'doc:add', docId: d.id, name: room.docs[d.id].name });
      console.log('文書追加:', room.code, d.name);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 個別文書の取得(doc:add通知を受けた参加者用)
  const mDoc = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{6})\/docs\/([^/]+)$/);
  if (req.method === 'GET' && mDoc) {
    if (!getAuthUser(req, url)) return sendJson(res, 401, { error: 'ログインが必要です' });
    const room = rooms.get(mDoc[1].toUpperCase());
    const doc = room && room.docs[decodeURIComponent(mDoc[2])];
    if (!doc) return sendJson(res, 404, { error: '文書が見つかりません' });
    return sendJson(res, 200, { id: decodeURIComponent(mDoc[2]), name: doc.name, pdf: doc.pdf, annotations: doc.annotations });
  }

  // ルーム取得(参加: タイトル内の全文書)
  const m = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{6})$/);
  if (req.method === 'GET' && m) {
    if (!getAuthUser(req, url)) return sendJson(res, 401, { error: 'ログインが必要です' });
    const room = rooms.get(m[1].toUpperCase());
    if (!room) return sendJson(res, 404, { error: '共有コードが見つかりません' });
    const docs = Object.entries(room.docs).map(([id, d]) => ({ id, name: d.name, pdf: d.pdf, annotations: d.annotations }));
    return sendJson(res, 200, { code: room.code, name: room.name, docs });
  }

  // 静的ファイル
  let filePath = path.normalize(path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!filePath.startsWith(ROOT) || filePath.startsWith(DATA_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
});

/* ---- WebSocket ---- */
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const user = getAuthUser(req, url);
  if (!user) { ws.close(4401, 'unauthorized'); return; }
  const code = (url.searchParams.get('code') || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) { ws.close(4404, 'room not found'); return; }

  ws.username = user;
  room.clients.add(ws);
  const names = () => [...room.clients].map(c => c.username);
  const allAnnotations = {};
  for (const [id, d] of Object.entries(room.docs)) allAnnotations[id] = d.annotations;
  ws.send(JSON.stringify({ type: 'init', annotations: allAnnotations, members: room.clients.size, names: names() }));
  broadcast(room, { type: 'members', count: room.clients.size, names: names() }, ws);
  console.log(`参加: ${code} ${user} (${room.clients.size}人)`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'op' && msg.docId && msg.page && msg.op) {
      if (applyOp(room, msg.docId, msg.page, msg.op)) {
        broadcast(room, { type: 'op', docId: msg.docId, page: msg.page, op: msg.op }, ws);
        if (msg.seq != null) ws.send(JSON.stringify({ type: 'ack', seq: msg.seq }));
      }
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    broadcast(room, { type: 'members', count: room.clients.size, names: names() });
    console.log(`退出: ${code} ${user} (${room.clients.size}人)`);
  });
});

server.listen(PORT, () => {
  console.log(`PDFノート サーバー起動: http://localhost:${PORT}`);
});
