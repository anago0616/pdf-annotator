// 2人目の参加者をシミュレートする検証スクリプト
// 使い方: node test-client.js <共有コード> <トークン> [docId]
// docId を渡すと6秒後にその文書へストロークを送信。受信メッセージを全てログ出力し25秒で終了。
const WebSocket = require('ws');
const code = process.argv[2];
const token = process.argv[3] || '';
const docId = process.argv[4] || '';
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const ws = new WebSocket(`ws://localhost:8741/ws?code=${code}&token=${token}`);

ws.on('open', () => {
  log('CONNECTED');
  if (docId) {
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: 'op', seq: 1, docId, page: 1,
        op: { kind: 'stroke:add', stroke: { tool: 'pen', color: '#188038', width: 5, points: [[100, 400], [200, 400], [200, 500]] } }
      }));
      log('SENT stroke to ' + docId);
    }, 6000);
  }
  setTimeout(() => { log('DONE'); ws.close(); process.exit(0); }, 25000);
});
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'init') log('RECV init members=' + m.members + ' docs=' + Object.keys(m.annotations).length);
  else if (m.type === 'members') log('RECV members=' + m.count + ' [' + (m.names || []).join(',') + ']');
  else if (m.type === 'ack') log('RECV ack seq=' + m.seq);
  else if (m.type === 'doc:add') log('RECV doc:add ' + m.docId + ' name=' + m.name);
  else if (m.type === 'op') log(`RECV op doc=${m.docId} kind=${m.op.kind} page=${m.page}` + (m.op.stroke ? ` color=${m.op.stroke.color}` : ''));
});
ws.on('close', (codeNum, reason) => log(`CLOSED code=${codeNum} reason=${reason}`));
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
