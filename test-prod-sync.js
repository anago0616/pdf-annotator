// 本番(Render)のリアルタイム同期検証: 2クライアントを繋ぎ、片方のopが他方に届くか
const WebSocket = require('ws');
const code = process.argv[2];
const base = 'wss://pdf-note.onrender.com/ws?code=' + code;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const a = new WebSocket(base + '&name=Aさん');
const b = new WebSocket(base + '&name=Bさん');
let bGotOp = false;

a.on('open', () => log('A 接続'));
b.on('open', () => log('B 接続'));
a.on('error', e => log('A error', e.message));
b.on('error', e => log('B error', e.message));

b.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'init') log('B init: members=' + m.members + ' names=' + (m.names||[]).join(','));
  if (m.type === 'members') log('B members=' + m.count + ' [' + (m.names||[]).join(',') + ']');
  if (m.type === 'op') { bGotOp = true; log('★ B が op を受信: doc=' + m.docId + ' color=' + (m.op.stroke && m.op.stroke.color)); }
});
a.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'init') log('A init: members=' + m.members);
});

// 両方つながったら、Aがストロークを送る
setTimeout(() => {
  log('A が描画opを送信...');
  a.send(JSON.stringify({ type:'op', seq:1, docId:'doctest1', page:1,
    op:{ kind:'stroke:add', stroke:{ tool:'pen', color:'#d93025', width:3, points:[[10,10],[50,50]] } } }));
}, 4000);

setTimeout(() => {
  log(bGotOp ? '=> 結果: リアルタイム同期 OK' : '=> 結果: ★同期されていない(Bがopを受信しなかった)');
  process.exit(0);
}, 9000);
