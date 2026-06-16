// 共有ルームに接続し、doc:rename と init の docNames を監視する検証クライアント
const WebSocket = require('ws');
const code = process.argv[2];
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
const ws = new WebSocket('ws://localhost:8741/ws?code=' + code + '&name=監視');
ws.on('open', () => log('接続'));
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'init') log('init docNames=' + JSON.stringify(m.docNames));
  if (m.type === 'doc:rename') log('★ doc:rename 受信: docId=' + m.docId + ' → "' + m.name + '"');
});
ws.on('error', e => log('error', e.message));
setTimeout(() => { log('終了'); process.exit(0); }, 12000);
