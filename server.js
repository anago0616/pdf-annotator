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

/* ---- 表示名(ログイン不要・任意) ----
 * 共有の参加者表示用。クライアントが name クエリを送れば使い、なければ「ゲスト」。
 */
function getDisplayName(url) {
  const n = url && url.searchParams.get('name');
  return (n && n.trim()) ? n.trim().slice(0, 20) : 'ゲスト';
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
    rooms.set(r.code, { deleted: [], ...r, clients: new Set(), saveTimer: null });
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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ---- 共有API(ログイン不要) ----
  // 共有ルーム作成/復元(タイトル単位・複数文書)
  // body.code を指定すると、そのコードでルームを作成または復元する(無料プラン再起動でルームが消えた時の自己修復用)
  if (req.method === 'POST' && url.pathname === '/api/share') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      if (!Array.isArray(body.docs) || body.docs.length === 0) return sendJson(res, 400, { error: '文書がありません' });
      const docs = {};
      for (const d of body.docs) {
        if (!d.id || typeof d.pdf !== 'string') return sendJson(res, 400, { error: '文書データが不正です' });
        docs[d.id] = { name: String(d.name || '無題'), category: String(d.category || '未分類'), pdf: d.pdf, annotations: d.annotations || {} };
      }
      const wantCode = (typeof body.code === 'string' && /^[A-Za-z0-9]{6}$/.test(body.code)) ? body.code.toUpperCase() : null;
      let room = wantCode ? rooms.get(wantCode) : null;
      if (room) {
        // 既存ルームへ統合(まだ無い文書だけ追加。削除済みは復活させない。既存文書の注釈は維持)
        for (const [id, d] of Object.entries(docs)) {
          if (!room.docs[id] && !room.deleted.includes(id)) room.docs[id] = d;
        }
        persistRoom(room);
        console.log('ルーム統合:', room.code);
        return sendJson(res, 200, { code: room.code });
      }
      const code = wantCode || newCode();
      room = { code, name: String(body.name || '無題'), docs, deleted: [], clients: new Set(), saveTimer: null };
      rooms.set(code, room);
      persistRoom(room);
      console.log((wantCode ? 'ルーム復元:' : 'ルーム作成:'), code, room.name, `(${body.docs.length}文書)`);
      return sendJson(res, 200, { code });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 共有中のタイトルへ文書を追加
  const mAdd = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{6})\/docs$/);
  if (req.method === 'POST' && mAdd) {
    const room = rooms.get(mAdd[1].toUpperCase());
    if (!room) return sendJson(res, 404, { error: '共有コードが見つかりません' });
    try {
      const d = JSON.parse((await readBody(req)).toString('utf8'));
      if (!d.id || typeof d.pdf !== 'string') return sendJson(res, 400, { error: '文書データが不正です' });
      room.docs[d.id] = { name: String(d.name || '無題'), category: String(d.category || '未分類'), pdf: d.pdf, annotations: d.annotations || {} };
      persistRoom(room);
      broadcast(room, { type: 'doc:add', docId: d.id, name: room.docs[d.id].name });
      console.log('文書追加:', room.code, d.name);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 文書名の変更(共有相手にも反映)
  const mRename = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{6})\/docs\/([^/]+)\/rename$/);
  if (req.method === 'POST' && mRename) {
    const room = rooms.get(mRename[1].toUpperCase());
    if (!room) return sendJson(res, 404, { error: '共有コードが見つかりません' });
    const docId = decodeURIComponent(mRename[2]);
    if (!room.docs[docId]) return sendJson(res, 404, { error: '文書が見つかりません' });
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const name = String(body.name || '').trim() || '無題';
      room.docs[docId].name = name;
      persistRoom(room);
      broadcast(room, { type: 'doc:rename', docId, name });
      console.log('文書名変更:', room.code, docId, '→', name);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 文書の削除(共有相手にも反映)
  const mDel = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{6})\/docs\/([^/]+)$/);
  if (req.method === 'DELETE' && mDel) {
    const room = rooms.get(mDel[1].toUpperCase());
    if (!room) return sendJson(res, 404, { error: '共有コードが見つかりません' });
    const docId = decodeURIComponent(mDel[2]);
    delete room.docs[docId];
    if (!room.deleted.includes(docId)) room.deleted.push(docId);
    if (room.deleted.length > 500) room.deleted.shift(); // 際限なく増えないように
    persistRoom(room);
    broadcast(room, { type: 'doc:delete', docId });
    console.log('文書削除:', room.code, docId);
    return sendJson(res, 200, { ok: true });
  }

  // 軽量メタ取得(文書名のみ。一覧画面の名前同期用・PDFは含めない)
  const mMeta = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{6})\/meta$/);
  if (req.method === 'GET' && mMeta) {
    const room = rooms.get(mMeta[1].toUpperCase());
    if (!room) return sendJson(res, 404, { error: '共有コードが見つかりません' });
    const docs = {};
    for (const [id, d] of Object.entries(room.docs)) docs[id] = d.name;
    return sendJson(res, 200, { name: room.name, docs, deleted: room.deleted });
  }

  // 個別文書の取得(doc:add通知を受けた参加者用)
  const mDoc = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{6})\/docs\/([^/]+)$/);
  if (req.method === 'GET' && mDoc) {
    const room = rooms.get(mDoc[1].toUpperCase());
    const doc = room && room.docs[decodeURIComponent(mDoc[2])];
    if (!doc) return sendJson(res, 404, { error: '文書が見つかりません' });
    return sendJson(res, 200, { id: decodeURIComponent(mDoc[2]), name: doc.name, category: doc.category || '未分類', pdf: doc.pdf, annotations: doc.annotations });
  }

  // ルーム取得(参加: 全文書)
  const m = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{6})$/);
  if (req.method === 'GET' && m) {
    const room = rooms.get(m[1].toUpperCase());
    if (!room) return sendJson(res, 404, { error: '共有コードが見つかりません' });
    const docs = Object.entries(room.docs).map(([id, d]) => ({ id, name: d.name, category: d.category || '未分類', pdf: d.pdf, annotations: d.annotations }));
    return sendJson(res, 200, { code: room.code, name: room.name, docs });
  }

  // 死活確認(自己ping・監視用。軽量)
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

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
  const user = getDisplayName(url);
  const code = (url.searchParams.get('code') || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) { ws.close(4404, 'room not found'); return; }

  ws.username = user;
  room.clients.add(ws);
  const names = () => [...room.clients].map(c => c.username);
  const allAnnotations = {};
  const docNames = {};
  for (const [id, d] of Object.entries(room.docs)) { allAnnotations[id] = d.annotations; docNames[id] = d.name; }
  ws.send(JSON.stringify({ type: 'init', annotations: allAnnotations, docNames, deleted: room.deleted, members: room.clients.size, names: names() }));
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

/* ---- スリープ防止(無料プラン用・自己ping) ----
 * Render無料プランは15分アクセスがないとスリープし、復帰に数十秒かかる。
 * 自分の公開URLを10分ごとに叩いて起こし続け、初回の待ち画面が出ないようにする。
 */
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  const https = require('https');
  const ping = () => {
    https.get(SELF_URL + '/healthz', (r) => { r.resume(); })
      .on('error', () => {});
  };
  setInterval(ping, 10 * 60 * 1000); // 10分ごと(スリープ閾値15分より短く)
  console.log('スリープ防止の自己pingを有効化:', SELF_URL);
}
