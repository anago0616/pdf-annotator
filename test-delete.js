// 共有ルームに接続し、doc:delete と init.deleted を監視する検証クライアント
const WebSocket = require('ws');
const code = process.argv[2];
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
const ws = new WebSocket('ws://localhost:8741/ws?code=' + code + '&name=監視');
ws.on('open', () => log('接続'));
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'init') log('init docs=' + Object.keys(m.docNames||{}).length + ' deleted=' + JSON.stringify(m.deleted));
  if (m.type === 'doc:delete') log('★ doc:delete 受信: docId=' + m.docId);
});
ws.on('error', e => log('error', e.message));
setTimeout(() => { log('終了'); process.exit(0); }, 12000);
