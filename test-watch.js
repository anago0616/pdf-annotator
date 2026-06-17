// ライブラリ同期の総合監視: 全メッセージ種別をログ
const WebSocket = require('ws');
const code = process.argv[2];
const secs = +(process.argv[3] || 20);
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
const ws = new WebSocket('ws://localhost:8741/ws?code=' + code + '&name=スマホ');
ws.on('open', () => log('接続'));
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'init') log('init: docs=' + Object.keys(m.docNames||{}).length + ' members=' + m.members + ' deleted=' + JSON.stringify(m.deleted));
  else if (m.type === 'members') log('members=' + m.count + ' [' + (m.names||[]).join(',') + ']');
  else if (m.type === 'doc:add') log('★ doc:add: ' + m.docId + ' "' + m.name + '"');
  else if (m.type === 'doc:delete') log('★ doc:delete: ' + m.docId);
  else if (m.type === 'doc:rename') log('★ doc:rename: ' + m.docId + ' → "' + m.name + '"');
  else if (m.type === 'op') log('★ op: doc=' + m.docId + ' kind=' + m.op.kind + (m.op.stroke?(' color='+m.op.stroke.color):''));
  else if (m.type === 'ack') {}
});
ws.on('error', e => log('error', e.message));
setTimeout(() => { log('終了'); process.exit(0); }, secs*1000);
