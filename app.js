'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ================= IndexedDB ================= */
const DB_NAME = 'pdfAnnotator';
let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('docs', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function dbOp(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('docs', mode);
    const req = fn(tx.objectStore('docs'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const dbPut = (doc) => dbOp('readwrite', s => s.put(doc));
const dbGet = (id) => dbOp('readonly', s => s.get(id));
const dbAll = () => dbOp('readonly', s => s.getAll());
const dbDelete = (id) => dbOp('readwrite', s => s.delete(id));

/* ================= 状態 ================= */
const COLORS = ['#d93025', '#1a73e8', '#188038', '#f9ab00', '#202124'];
const state = {
  doc: null,        // {id, name, pdfData(ArrayBuffer), annotations, pageCount, updatedAt}
  pdf: null,        // pdf.js document
  tool: 'hand',
  color: COLORS[0],
  width: 3,
  zoom: 1,
  baseScale: 1,     // 画面幅フィット倍率
  undoStack: [],    // {page, snapshot}
  pages: [],        // {wrap, canvas, overlay, viewport, num}
  editingText: null, // {page, index} 編集中テキスト / {page, x, y} 新規
  selectedText: null, // {page, index} 選択中テキスト(移動・リサイズ用)
  pinching: false   // 2本指ピンチ操作中
};

// テキスト寸法の測定用(ページ座標系)
const _measureCtx = document.createElement('canvas').getContext('2d');
function textMetrics(t) {
  _measureCtx.font = `${t.size}px -apple-system, "Hiragino Sans", "Yu Gothic UI", sans-serif`;
  const lines = t.text.split('\n');
  if (t.vertical) {
    // 縦書き: 文字を縦に積み、行は右→左。1列の幅 colW
    const colW = t.size * 1.4;
    let maxChars = 1;
    for (const l of lines) maxChars = Math.max(maxChars, [...l].length);
    return { w: lines.length * colW, h: maxChars * t.size * 1.1, lines, colW, vertical: true };
  }
  let w = 1;
  for (const l of lines) w = Math.max(w, _measureCtx.measureText(l).width);
  return { w, h: lines.length * t.size * 1.3, lines, vertical: false };
}
// テキストのヒット判定(ページ座標)。当たったindex、なければ -1
function hitText(ann, x, y) {
  for (let i = ann.texts.length - 1; i >= 0; i--) {
    const t = ann.texts[i];
    const m = textMetrics(t);
    if (x >= t.x && x <= t.x + m.w && y >= t.y && y <= t.y + m.h) return i;
  }
  return -1;
}

const $ = (id) => document.getElementById(id);
const views = { home: $('homeView'), editor: $('editorView') };

function showToast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { t.hidden = true; }, ms);
}

function pageAnn(doc, num) {
  if (!doc.annotations[num]) doc.annotations[num] = { strokes: [], texts: [] };
  return doc.annotations[num];
}

/* ================= 表示名(ログイン不要・共有の参加者表示用) ================= */
// 共有時に相手に表示される名前。任意。未設定なら「ゲスト」。
function getGuestName() {
  return localStorage.getItem('pdfnote_name') || '';
}

/* ================= ホーム画面 ================= */
let selectMode = false;          // 一括選択モード
const selectedIds = new Set();   // 選択中の文書ID

// 複数文書をまとめて削除(共有中なら相手の端末からも削除)
async function deleteDocs(docs) {
  for (const d of docs) {
    if (d.shareCode && d.remoteId) {
      fetch(`/api/share/${d.shareCode}/docs/${encodeURIComponent(d.remoteId)}`, { method: 'DELETE' }).catch(() => {});
    }
    await dbDelete(d.id);
  }
}

function updateBulkBar() {
  const bar = $('bulkBar');
  bar.hidden = !selectMode;
  if (!selectMode) return;
  $('bulkCount').textContent = `${selectedIds.size}件選択`;
  $('bulkDelete').disabled = selectedIds.size === 0;
}

async function renderHome() {
  views.editor.hidden = true;
  views.home.hidden = false;
  $('selectBtn').textContent = selectMode ? '✕ 解除' : '☑ 選択';
  $('addBtn').style.display = selectMode ? 'none' : '';
  updateBulkBar();
  // 文書は名前の昇順で固定表示(数字は自然順。例: 資料2 < 資料10)
  const docs = (await dbAll()).sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
  const list = $('docList');
  list.innerHTML = '';
  $('emptyState').hidden = docs.length > 0;

  // タイトル(グループ)ごとにまとめる
  const groups = new Map();
  for (const d of docs) {
    const cat = d.category || '未分類';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(d);
  }
  const cats = [...groups.keys()].sort((a, b) => {
    if (a === '未分類') return 1;
    if (b === '未分類') return -1;
    return a.localeCompare(b, 'ja');
  });
  const collapsed = new Set(JSON.parse(localStorage.getItem('pdfnote_collapsed') || '[]'));

  for (const cat of cats) {
    const items = groups.get(cat);
    const isClosed = collapsed.has(cat);

    const groupCode = (items.find(d => d.shareCode) || {}).shareCode;
    const conn = groupCode ? conns.get(groupCode) : null;
    const shareLabel = groupCode
      ? `🔗 ${groupCode}${conn && !conn.offline ? ' ・' + (conn.members || 1) + '台' : ''}`
      : '🔗 共有';
    const header = document.createElement('div');
    header.className = 'cat-header';
    header.innerHTML = `<span class="cat-arrow">${isClosed ? '▶' : '▼'}</span>📁 <span class="cat-name"></span><span class="cat-count">${items.length}</span><span class="spacer"></span><button class="cat-share-btn${groupCode ? ' shared' : ''}"></button>`;
    header.querySelector('.cat-name').textContent = cat;
    header.querySelector('.cat-share-btn').textContent = shareLabel;
    header.addEventListener('click', () => {
      if (collapsed.has(cat)) collapsed.delete(cat);
      else collapsed.add(cat);
      localStorage.setItem('pdfnote_collapsed', JSON.stringify([...collapsed]));
      renderHome();
    });
    header.querySelector('.cat-share-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        if (groupCode) { showShareDialog(groupCode, cat); }
        else {
          if (!confirm(`「${cat}」の${items.length}件を共有しますか？(コードを相手に伝えると同期されます)`)) return;
          const code = await shareFolder(cat);
          showShareDialog(code, cat);
        }
      } catch (err) { console.error(err); showToast('共有サーバーに接続できません'); }
    });
    list.appendChild(header);
    if (isClosed) continue;

    for (const d of items) {
      const card = document.createElement('div');
      card.className = 'doc-card';
      if (selectMode && selectedIds.has(d.id)) card.classList.add('selected');
      card.innerHTML = `
        ${selectMode ? `<div class="doc-check">${selectedIds.has(d.id) ? '✓' : ''}</div>` : '<div class="doc-icon">📄</div>'}
        <div class="doc-info">
          <div class="doc-name"></div>
          <div class="doc-meta">${d.pageCount}ページ ・ ${new Date(d.updatedAt).toLocaleString('ja-JP')}</div>
        </div>
        <div class="doc-actions">
          <button class="icon-btn act-rename" title="名前を変更">✏️</button>
          <button class="icon-btn act-move" title="タイトルを変更">📁</button>
          <button class="icon-btn act-share" title="共有">📤</button>
          <button class="icon-btn act-delete" title="削除">🗑️</button>
        </div>`;
      card.querySelector('.doc-name').textContent = d.name;
      if (selectMode) {
        // 選択モード: カードのタップで選択トグル
        const toggle = () => {
          if (selectedIds.has(d.id)) selectedIds.delete(d.id);
          else selectedIds.add(d.id);
          renderHome();
        };
        card.querySelector('.doc-check').addEventListener('click', toggle);
        card.querySelector('.doc-info').addEventListener('click', toggle);
        list.appendChild(card);
        continue;
      }
      card.querySelector('.doc-info').addEventListener('click', () => openEditor(d.id));
      card.querySelector('.doc-icon').addEventListener('click', () => openEditor(d.id));
      card.querySelector('.act-rename').addEventListener('click', async () => {
        const name = prompt('新しい名前', d.name);
        if (name && name.trim()) {
          d.name = name.trim();
          await dbPut(d);
          // 共有中なら相手にも名前変更を反映(ルームが消えていれば作り直して確実に残す)
          if (d.shareCode && d.remoteId) {
            fetch(`/api/share/${d.shareCode}/docs/${encodeURIComponent(d.remoteId)}/rename`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: d.name })
            }).then(res => { if (res.status === 404) recreateRoom(d.shareCode); }).catch(() => {});
          }
          renderHome();
        }
      });
      card.querySelector('.act-move').addEventListener('click', async () => {
        const cat2 = prompt('移動先のタイトル(グループ名)', d.category || '未分類');
        if (cat2 != null) {
          d.category = cat2.trim() || '未分類';
          await dbPut(d);
          renderHome();
        }
      });
      card.querySelector('.act-share').addEventListener('click', () => shareDoc(d));
      card.querySelector('.act-delete').addEventListener('click', async () => {
        if (confirm(`「${d.name}」を削除しますか？`)) {
          await deleteDocs([d]);
          renderHome();
        }
      });
      list.appendChild(card);
    }
  }
  applySyncUI();
}

async function importPdf(name, arrayBuffer, category = '未分類') {
  // ページ数を確認しつつ妥当性チェック
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  const doc = {
    id: 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    name: name.replace(/\.pdf$/i, ''),
    category,
    pdfData: arrayBuffer,
    annotations: {},
    pageCount: pdf.numPages,
    updatedAt: Date.now()
  };
  await dbPut(doc);
  await pdf.destroy();
  return doc;
}

/* ---- 取り込み(複数対応・タイトル指定) ---- */
let pendingFiles = null;

$('addBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  pendingFiles = files;
  // 既存タイトルを候補に表示
  const cats = [...new Set((await dbAll()).map(d => d.category || '未分類'))];
  $('categoryList').innerHTML = cats.map(c => `<option value="${c.replace(/"/g, '&quot;')}">`).join('');
  $('importInfo').textContent = files.length === 1
    ? `「${files[0].name}」を取り込みます。管理用のタイトルを付けられます(省略可)`
    : `${files.length}件のPDFをまとめて取り込みます。管理用のタイトルを付けられます(省略可)`;
  $('importCategory').value = '';
  $('importDialog').hidden = false;
});

$('importCancelBtn').addEventListener('click', () => {
  pendingFiles = null;
  $('importDialog').hidden = true;
});

$('importOkBtn').addEventListener('click', async () => {
  const files = pendingFiles || [];
  pendingFiles = null;
  $('importDialog').hidden = true;
  const category = $('importCategory').value.trim() || '未分類';
  // 取り込み先フォルダが共有中なら、新しい文書もそのフォルダの共有に追加
  const folderCode = ((await dbAll()).find(d => (d.category || '未分類') === category && d.shareCode) || {}).shareCode;
  let ok = 0, fail = 0, lastDoc = null;
  for (const file of files) {
    try {
      lastDoc = await importPdf(file.name, await file.arrayBuffer(), category);
      if (folderCode) {
        lastDoc.shareCode = folderCode; lastDoc.remoteId = lastDoc.id;
        await dbPut(lastDoc);
        await addDocToFolderShare(lastDoc); // フォルダ共有中なら配信
      }
      ok++;
    } catch (err) {
      console.error('取り込み失敗:', file.name, err);
      fail++;
    }
  }
  if (fail) showToast(`${ok}件を取り込みました(${fail}件は失敗)`);
  else showToast(`${ok}件のPDFを取り込みました`);
  if (ok === 1 && files.length === 1) openEditor(lastDoc.id);
  else renderHome();
});

/* ================= 編集画面 ================= */
async function openEditor(id) {
  const doc = await dbGet(id);
  if (!doc) return showToast('文書が見つかりません');
  state.doc = doc;
  state.zoom = 1;
  state.undoStack = [];
  state.selectedText = null;
  resetGestureState(); // 別ファイルを開くたびにジェスチャ状態をクリア(固まり対策)
  $('docTitle').textContent = doc.name;
  $('saveStatus').textContent = '';
  views.home.hidden = true;
  views.editor.hidden = false;
  updateTextToolbar();
  // ライブラリ同期は常時接続なので個別接続はしない。状態表示のみ更新。
  applySyncUI();
  state.pdf = await pdfjsLib.getDocument({ data: doc.pdfData.slice(0) }).promise;
  await renderAllPages();
  setTool('hand');
}

// エディタを閉じてホームへ(同期接続は維持)
function backToHome() {
  clearTimeout(saveTimer);
  if (state.doc) { state.doc.updatedAt = Date.now(); dbPut(state.doc); }
  if (state.pdf) { try { state.pdf.destroy(); } catch (_) {} state.pdf = null; }
  state.doc = null;
  renderHome();
  applySyncUI();
}

async function renderAllPages() {
  const container = $('pageContainer');
  container.innerHTML = '';
  const inner = document.createElement('div');
  inner.id = 'pagesInner';
  container.appendChild(inner);
  state.pages = [];
  const baseDpr = window.devicePixelRatio || 1;
  // 高解像度のまま端末の上限を超えないようにする(超えるとブラウザが内部縮小してぼやける)
  // iOS Safari は概ね面積1677万px・1辺8192pxが上限
  const MAX_AREA = 16777216, MAX_DIM = 8192, OVERSAMPLE = 1.15;
  const availW = container.clientWidth - 16;

  for (let num = 1; num <= state.pdf.numPages; num++) {
    const page = await state.pdf.getPage(num);
    const vp1 = page.getViewport({ scale: 1 });
    if (num === 1) state.baseScale = availW / vp1.width;
    const scale = state.baseScale * state.zoom;
    const vp = page.getViewport({ scale });

    // 実効解像度: 低〜中倍率では画質優先、高倍率では上限優先
    let dpr = baseDpr * OVERSAMPLE;
    const maxDprForArea = Math.sqrt(MAX_AREA / (vp.width * vp.height));
    const maxDprForDim = Math.min(MAX_DIM / vp.width, MAX_DIM / vp.height);
    dpr = Math.min(dpr, maxDprForArea, maxDprForDim);
    // 低倍率(4倍未満)では画質を保つ。高倍率では上限を優先する(ぼやけるがクラッシュ防止)
    if (state.zoom < 4) { dpr = Math.max(baseDpr, dpr); } else { dpr = Math.max(1, dpr); }

    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + 'px';
    canvas.style.height = vp.height + 'px';

    const overlay = document.createElement('canvas');
    overlay.className = 'overlay';
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    overlay.style.width = canvas.style.width;
    overlay.style.height = canvas.style.height;

    const label = document.createElement('span');
    label.className = 'page-num';
    label.textContent = `${num} / ${state.pdf.numPages}`;

    wrap.append(canvas, overlay, label);
    inner.appendChild(wrap);

    // 入力ハンドラと注釈描画は PDF ラスタライズを待たずに先に有効化(即書き込み可)
    const info = { wrap, canvas, overlay, num, scale, dpr, pageW: vp1.width, pageH: vp1.height };
    state.pages.push(info);
    attachPointerHandlers(info);
    redrawOverlay(info);

    // PDF本体の描画は並列・非同期(各ページ独立)
    page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: [dpr, 0, 0, dpr, 0, 0] }).promise
      .catch(err => { if (err && err.name !== 'RenderingCancelledException') console.error('PDF描画エラー p' + num, err); });
  }
  updateOverlayInteractivity();
}

/* ---- 注釈の描画(オーバーレイ) ---- */
function drawAnnotations(ctx, ann, factor) {
  for (const s of ann.strokes) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width * factor;
    if (s.tool === 'marker') {
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = s.width * 3 * factor;
    }
    ctx.beginPath();
    s.points.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x * factor, y * factor);
      else ctx.lineTo(x * factor, y * factor);
    });
    if (s.points.length === 1) {
      const [x, y] = s.points[0];
      ctx.lineTo(x * factor + 0.1, y * factor);
    }
    ctx.stroke();
    ctx.restore();
  }
  for (const t of ann.texts) {
    ctx.save();
    ctx.fillStyle = t.color;
    ctx.font = `${t.size * factor}px -apple-system, "Hiragino Sans", "Yu Gothic UI", sans-serif`;
    ctx.textBaseline = 'top';
    const lines = t.text.split('\n');
    if (t.vertical) {
      const colW = t.size * 1.4;
      ctx.textAlign = 'center';
      lines.forEach((line, li) => {
        const cx = (t.x + (lines.length - 1 - li) * colW + colW / 2) * factor; // 行は右→左
        [...line].forEach((ch, ci) => {
          ctx.fillText(ch, cx, (t.y + ci * t.size * 1.1) * factor);
        });
      });
    } else {
      ctx.textAlign = 'left';
      lines.forEach((line, i) => {
        ctx.fillText(line, t.x * factor, (t.y + i * t.size * 1.3) * factor);
      });
    }
    ctx.restore();
  }
}

function redrawOverlay(info) {
  const ctx = info.overlay.getContext('2d');
  ctx.clearRect(0, 0, info.overlay.width, info.overlay.height);
  const ann = pageAnn(state.doc, info.num);
  const factor = info.scale * info.dpr;
  drawAnnotations(ctx, ann, factor);
  // 選択中テキストの枠+リサイズハンドル
  const sel = state.selectedText;
  if (state.tool === 'text' && sel && sel.page === info.num && ann.texts[sel.index]) {
    const t = ann.texts[sel.index];
    const m = textMetrics(t);
    const pad = 4;
    ctx.save();
    ctx.strokeStyle = '#1a73e8';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(t.x * factor - pad, t.y * factor - pad, m.w * factor + pad * 2, m.h * factor + pad * 2);
    ctx.setLineDash([]);
    ctx.fillStyle = '#1a73e8';
    ctx.beginPath();
    ctx.arc((t.x + m.w) * factor + pad, (t.y + m.h) * factor + pad, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
  }
}

/* ---- ポインタ操作 ---- */
function attachPointerHandlers(info) {
  const ov = info.overlay;
  let stroke = null;
  let textAction = null; // {mode:'move'|'resize', index, ...}

  const toPageCoords = (e) => {
    const r = ov.getBoundingClientRect();
    return [(e.clientX - r.left) / info.scale, (e.clientY - r.top) / info.scale];
  };

  // ピンチ開始時に描きかけの線を取り消す(手のひら誤タッチ対策)
  info.cancelStroke = () => {
    if (!stroke) return;
    const ann = pageAnn(state.doc, info.num);
    const i = ann.strokes.indexOf(stroke);
    if (i >= 0) ann.strokes.splice(i, 1);
    state.undoStack.pop();
    stroke = null;
    redrawOverlay(info);
  };

  ov.addEventListener('pointerdown', (e) => {
    if (gestureBlocksDraw(e)) return;
    e.preventDefault();
    if (state.tool !== 'text') {
      try { ov.setPointerCapture(e.pointerId); } catch (_) {}
    }
    const [x, y] = toPageCoords(e);

    if (state.tool === 'pen' || state.tool === 'marker') {
      pushUndo(info.num);
      stroke = { tool: state.tool, color: state.color, width: state.width, points: [[x, y]] };
      pageAnn(state.doc, info.num).strokes.push(stroke);
      redrawOverlay(info);
    } else if (state.tool === 'eraser') {
      pushUndo(info.num);
      eraseAt(info, x, y);
    } else if (state.tool === 'text') {
      const ann = pageAnn(state.doc, info.num);
      const sel = state.selectedText;
      // 1) 選択中テキストの右下ハンドル → リサイズ開始
      if (sel && sel.page === info.num && ann.texts[sel.index]) {
        const t = ann.texts[sel.index];
        const m = textMetrics(t);
        const hs = 28 / info.scale; // ハンドル当たり判定(ページ単位・指でも掴みやすく)
        if (Math.abs(x - (t.x + m.w)) < hs && Math.abs(y - (t.y + m.h)) < hs) {
          pushUndo(info.num);
          textAction = { mode: 'resize', index: sel.index, origSize: t.size, origW: m.w };
          try { ov.setPointerCapture(e.pointerId); } catch (_) {}
          return;
        }
      }
      // 2) テキスト本体 → 選択して移動開始(離した時にタップ判定で編集)
      const idx = hitText(ann, x, y);
      if (idx >= 0) {
        const wasSel = sel && sel.page === info.num && sel.index === idx;
        state.selectedText = { page: info.num, index: idx };
        const t = ann.texts[idx];
        pushUndo(info.num);
        textAction = { mode: 'move', index: idx, startX: x, startY: y, origX: t.x, origY: t.y, moved: false, wasSel };
        try { ov.setPointerCapture(e.pointerId); } catch (_) {}
        redrawOverlay(info);
        updateTextToolbar();
        return;
      }
      // 3) 空白 → 選択解除、なければ新規テキスト作成
      if (state.selectedText) { state.selectedText = null; redrawOverlay(info); updateTextToolbar(); }
      else openNewTextEditor(info, x, y);
    }
  });

  ov.addEventListener('pointermove', (e) => {
    if (state.tool === 'hand') return;
    if (state.pinching) { stroke = null; textAction = null; return; }
    if (textAction) {
      const [x, y] = toPageCoords(e);
      const ann = pageAnn(state.doc, info.num);
      const t = ann.texts[textAction.index];
      if (!t) { textAction = null; return; }
      if (textAction.mode === 'move') {
        const dx = x - textAction.startX, dy = y - textAction.startY;
        if (Math.hypot(dx, dy) > 3 / info.scale) textAction.moved = true;
        t.x = textAction.origX + dx;
        t.y = textAction.origY + dy;
      } else {
        const newW = Math.max(8 / info.scale, x - t.x);
        const ratio = newW / Math.max(1, textAction.origW);
        t.size = Math.max(8, Math.min(400, Math.round(textAction.origSize * ratio)));
      }
      redrawOverlay(info);
      return;
    }
    if (stroke) {
      const [x, y] = toPageCoords(e);
      const last = stroke.points[stroke.points.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) > 0.7) {
        stroke.points.push([x, y]);
        redrawOverlay(info);
      }
    } else if (state.tool === 'eraser' && e.buttons) {
      const [x, y] = toPageCoords(e);
      eraseAt(info, x, y);
    }
  });

  const finish = () => {
    if (textAction) {
      const ta = textAction;
      textAction = null;
      if (ta.mode === 'move' && !ta.moved) {
        // 移動せずタップ: 既に選択済みだった文字なら編集を開く
        state.undoStack.pop(); // 何も変えていない
        if (ta.wasSel) openTextEditorFor(info, ta.index);
      } else {
        scheduleSave();
        sendPageSet(info.num);
        updateTextToolbar();
      }
      return;
    }
    if (stroke) {
      const committed = stroke;
      stroke = null;
      scheduleSave();
      sendOp(info.num, { kind: 'stroke:add', stroke: committed });
    } else if (state.tool === 'eraser') {
      scheduleSave();
      sendPageSet(info.num);
    }
  };
  ov.addEventListener('pointerup', finish);
  ov.addEventListener('pointercancel', finish);
}

function updateOverlayInteractivity() {
  for (const p of state.pages) {
    p.overlay.style.pointerEvents = state.tool === 'hand' ? 'none' : 'auto';
  }
}

function eraseAt(info, x, y) {
  const ann = pageAnn(state.doc, info.num);
  const radius = 12 / state.zoom;
  const before = ann.strokes.length + ann.texts.length;
  ann.strokes = ann.strokes.filter(s => !s.points.some(p => Math.hypot(p[0] - x, p[1] - y) < radius));
  ann.texts = ann.texts.filter(t => {
    const lines = t.text.split('\n');
    const h = lines.length * t.size * 1.3;
    const w = Math.max(...lines.map(l => l.length)) * t.size;
    return !(x > t.x - radius && x < t.x + w + radius && y > t.y - radius && y < t.y + h + radius);
  });
  if (before !== ann.strokes.length + ann.texts.length) redrawOverlay(info);
}

/* ---- テキスト ---- */
function openTextEditorFor(info, idx) {
  state.editingText = { page: info.num, index: idx };
  $('textInput').value = pageAnn(state.doc, info.num).texts[idx].text;
  $('textDeleteBtn').hidden = false;
  $('textEditor').hidden = false;
  $('textInput').focus();
}
function openNewTextEditor(info, x, y) {
  state.editingText = { page: info.num, x, y };
  $('textInput').value = '';
  $('textDeleteBtn').hidden = true;
  $('textEditor').hidden = false;
  $('textInput').focus();
}

function closeTextEditor() {
  $('textEditor').hidden = true;
  state.editingText = null;
}

$('textOkBtn').addEventListener('click', () => {
  const et = state.editingText;
  if (!et) return closeTextEditor();
  const text = $('textInput').value.trimEnd();
  const ann = pageAnn(state.doc, et.page);
  pushUndo(et.page);
  if (et.index != null) {
    if (text) { ann.texts[et.index].text = text; state.selectedText = { page: et.page, index: et.index }; }
    else { ann.texts.splice(et.index, 1); state.selectedText = null; }
  } else if (text) {
    ann.texts.push({ x: et.x, y: et.y, text, color: state.color, size: Math.max(10, state.width * 4) });
    state.selectedText = { page: et.page, index: ann.texts.length - 1 }; // 作成直後は選択(すぐ移動・リサイズ可)
  }
  const info = state.pages.find(p => p.num === et.page);
  if (info) redrawOverlay(info);
  scheduleSave();
  sendPageSet(et.page);
  closeTextEditor();
  updateTextToolbar();
});
$('textCancelBtn').addEventListener('click', closeTextEditor);
$('textDeleteBtn').addEventListener('click', () => {
  const et = state.editingText;
  if (et && et.index != null) {
    pushUndo(et.page);
    pageAnn(state.doc, et.page).texts.splice(et.index, 1);
    state.selectedText = null;
    const info = state.pages.find(p => p.num === et.page);
    if (info) redrawOverlay(info);
    scheduleSave();
    sendPageSet(et.page);
  }
  closeTextEditor();
  updateTextToolbar();
});

/* ---- テキスト選択中の編集バー(色・サイズ・縦横・編集・削除) ---- */
// 色ボタンを生成
const ttColors = $('ttColors');
COLORS.forEach((c) => {
  const b = document.createElement('div');
  b.className = 'tt-color';
  b.style.background = c;
  b.dataset.color = c;
  b.addEventListener('click', () => { state.color = c; withSelectedText((t) => { t.color = c; }); });
  ttColors.appendChild(b);
});

function selectedTextObj() {
  const sel = state.selectedText;
  if (!sel) return null;
  const t = pageAnn(state.doc, sel.page).texts[sel.index];
  return t ? { sel, t } : null;
}
// 選択中テキストを変更して再描画・保存・同期
function withSelectedText(fn) {
  const cur = selectedTextObj();
  if (!cur) return;
  pushUndo(cur.sel.page);
  fn(cur.t);
  const info = state.pages.find(p => p.num === cur.sel.page);
  if (info) redrawOverlay(info);
  scheduleSave();
  sendPageSet(cur.sel.page);
  updateTextToolbar();
}
function updateTextToolbar() {
  const tb = $('textToolbar');
  const cur = (state.tool === 'text' && !views.editor.hidden) ? selectedTextObj() : null;
  if (!cur) { tb.hidden = true; return; }
  tb.hidden = false;
  $('ttVertical').textContent = cur.t.vertical ? '横' : '縦'; // 押すと切り替わる先を表示
  ttColors.querySelectorAll('.tt-color').forEach(s => s.classList.toggle('active', s.dataset.color === cur.t.color));
}

$('ttSizeDown').addEventListener('click', () => withSelectedText((t) => { t.size = Math.max(8, t.size - 4); }));
$('ttSizeUp').addEventListener('click', () => withSelectedText((t) => { t.size = Math.min(400, t.size + 4); }));
$('ttVertical').addEventListener('click', () => withSelectedText((t) => { t.vertical = !t.vertical; }));
$('ttEdit').addEventListener('click', () => {
  const cur = selectedTextObj();
  if (!cur) return;
  const info = state.pages.find(p => p.num === cur.sel.page);
  if (info) openTextEditorFor(info, cur.sel.index);
});
$('ttDelete').addEventListener('click', () => {
  const sel = state.selectedText;
  if (!sel) return;
  pushUndo(sel.page);
  pageAnn(state.doc, sel.page).texts.splice(sel.index, 1);
  state.selectedText = null;
  const info = state.pages.find(p => p.num === sel.page);
  if (info) redrawOverlay(info);
  scheduleSave();
  sendPageSet(sel.page);
  updateTextToolbar();
});

/* ---- 元に戻す ---- */
function pushUndo(pageNum) {
  state.undoStack.push({ page: pageNum, snapshot: JSON.stringify(pageAnn(state.doc, pageNum)) });
  if (state.undoStack.length > 50) state.undoStack.shift();
}
$('undoBtn').addEventListener('click', () => {
  const entry = state.undoStack.pop();
  if (!entry) return showToast('これ以上戻せません');
  state.doc.annotations[entry.page] = JSON.parse(entry.snapshot);
  const info = state.pages.find(p => p.num === entry.page);
  if (info) redrawOverlay(info);
  scheduleSave();
  sendPageSet(entry.page);
});

/* ---- 保存(自動) ---- */
let saveTimer = null;
function scheduleSave() {
  $('saveStatus').textContent = '保存中…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    state.doc.updatedAt = Date.now();
    await dbPut(state.doc);
    $('saveStatus').textContent = '保存済み ✓';
  }, 600);
}

/* ---- ツール / 色 / 太さ ---- */
function setTool(tool) {
  state.tool = tool;
  resetGestureState(); // ツール切替時にジェスチャ残骸をクリア
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === tool));
  updateOverlayInteractivity();
  // テキスト以外に切り替えたら選択枠を消す
  if (tool !== 'text' && state.selectedText) {
    const sel = state.selectedText; state.selectedText = null;
    const info = state.pages.find(p => p.num === sel.page);
    if (info) redrawOverlay(info);
  }
  updateTextToolbar();
}
document.querySelectorAll('.tool-btn[data-tool]').forEach(b =>
  b.addEventListener('click', () => setTool(b.dataset.tool)));

const swatches = $('colorSwatches');
COLORS.forEach((c, i) => {
  const b = document.createElement('button');
  b.className = 'swatch' + (i === 0 ? ' active' : '');
  b.style.background = c;
  b.addEventListener('click', () => {
    state.color = c;
    swatches.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s === b));
  });
  swatches.appendChild(b);
});
$('widthSlider').addEventListener('input', (e) => {
  state.width = +e.target.value;
  $('widthLabel').textContent = e.target.value;
});

/* ---- ズーム ---- */
const ZOOM_MIN = 0.5, ZOOM_MAX = 8; // 画質優先: 高倍率でも解像度を保つため上限は8倍に
$('zoomInBtn').addEventListener('click', () => changeZoom(1.25));
$('zoomOutBtn').addEventListener('click', () => changeZoom(0.8));

async function changeZoom(factor) {
  const container = $('pageContainer');
  // ビューポート中央を基点に拡大縮小
  const focusX = container.scrollLeft + container.clientWidth / 2;
  const focusY = container.scrollTop + container.clientHeight / 2;
  const old = state.zoom;
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, old * factor));
  if (next === old) return;
  state.zoom = next;
  await renderAllPages();
  const ratio = next / old;
  container.scrollLeft = focusX * ratio - container.clientWidth / 2;
  container.scrollTop = focusY * ratio - container.clientHeight / 2;
}

/* ---- ピンチ操作(2本指で拡大縮小・パン) ---- */
const touchPts = new Map(); // pointerId -> 接地時刻  ※指の本数管理
function activeTouchCount() {
  // 取りこぼし対策: 5秒以上前の指(pointerupが来なかった分)は無効として掃除する
  // → これがないと残骸が溜まって「突然編集できなくなる」状態になる
  const now = Date.now();
  for (const [id, ts] of touchPts) if (now - ts > 5000) touchPts.delete(id);
  return touchPts.size;
}

// ジェスチャ状態を完全にリセット(固まり防止の総合対策)
function resetGestureState() {
  touchPts.clear();
  state.pinching = false;
}

// 描画/テキスト入力をブロックすべきか(2本指ピンチ等)。残骸は自己修復する。
function gestureBlocksDraw(e) {
  const n = activeTouchCount(); // 古い指は掃除される
  if (state.pinching && n < 2) state.pinching = false; // ピンチ残骸の自己修復
  return state.tool === 'hand' || state.pinching || (e.pointerType === 'touch' && n >= 2);
}

function setupPinchZoom() {
  const container = $('pageContainer');
  let pinch = null; // {startDist, anchorX, anchorY, innerLeft0, innerTop0, lastK, lastMx, lastMy}

  const getInner = () => document.getElementById('pagesInner');

  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const inner = getInner();
      if (!inner) return;
      // 描きかけの線をキャンセルしてピンチへ移行
      state.pinching = true;
      state.pages.forEach(p => p.cancelStroke && p.cancelStroke());
      const ir = inner.getBoundingClientRect();
      const [mx, my] = mid(e.touches);
      pinch = {
        startDist: dist(e.touches),
        // ピンチ中心の inner ローカル座標(現在の描画スケール基準)
        anchorX: mx - ir.left,
        anchorY: my - ir.top,
        innerLeft0: ir.left,
        innerTop0: ir.top,
        lastK: 1, lastMx: mx, lastMy: my
      };
      inner.style.transformOrigin = '0 0';
      inner.style.willChange = 'transform';
      e.preventDefault();
    }
  }, { passive: false });

  container.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length < 2) return;
    e.preventDefault();
    const inner = getInner();
    if (!inner) return;
    const k = dist(e.touches) / pinch.startDist;
    const [mx, my] = mid(e.touches);
    // アンカー点が指の中点に来るよう平行移動量を計算
    const tx = mx - pinch.innerLeft0 - k * pinch.anchorX;
    const ty = my - pinch.innerTop0 - k * pinch.anchorY;
    inner.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
    pinch.lastK = k; pinch.lastMx = mx; pinch.lastMy = my;
  }, { passive: false });

  const endPinch = async () => {
    if (!pinch) return;
    const inner = getInner();
    const p = pinch;
    pinch = null;
    const old = state.zoom;
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, old * p.lastK));
    const committedK = next / old;
    if (inner) { inner.style.transform = ''; inner.style.willChange = ''; }
    state.pinching = false; // 再描画の前に解除(描画ガードはジェスチャ中のみ必要)

    if (Math.abs(committedK - 1) < 0.01) return;

    state.zoom = next;
    await renderAllPages();
    // ピンチ中心の文書上の点を、指の中点位置に保つようスクロール
    const container2 = $('pageContainer');
    const cr = container2.getBoundingClientRect();
    container2.scrollLeft = p.anchorX * committedK - (p.lastMx - cr.left);
    container2.scrollTop = p.anchorY * committedK - (p.lastMy - cr.top);
  };

  container.addEventListener('touchend', (e) => {
    if (pinch && e.touches.length < 2) endPinch();
  });
  container.addEventListener('touchcancel', (e) => {
    if (pinch && e.touches.length < 2) endPinch();
  });

  // 指の本数を pointer で追跡(描画ハンドラの2本指判定に使用)
  container.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') touchPts.set(e.pointerId, Date.now());
  }, true);
  // 解除は window で拾う(描画中にオーバーレイがキャプチャした指の pointerup を
  // container では取りこぼすことがあり、本数が減らず編集不能になるのを防ぐ)
  const dropPt = (e) => {
    if (e.pointerType !== 'touch') return;
    touchPts.delete(e.pointerId);
    if (touchPts.size === 0) state.pinching = false; // 全指が離れたらピンチ状態を確実に解除
  };
  window.addEventListener('pointerup', dropPt, true);
  window.addEventListener('pointercancel', dropPt, true);
  window.addEventListener('lostpointercapture', dropPt, true);
}

/* ---- 戻る ---- */
$('backBtn').addEventListener('click', () => backToHome());

/* ================= 書き出し・共有 ================= */
async function exportAnnotatedPdf(doc) {
  const { PDFDocument } = PDFLib;
  const pdfDoc = await PDFDocument.load(doc.pdfData);
  const pages = pdfDoc.getPages();

  for (let i = 0; i < pages.length; i++) {
    const num = i + 1;
    const ann = doc.annotations[num];
    if (!ann || (ann.strokes.length === 0 && ann.texts.length === 0)) continue;

    const page = pages[i];
    const { width: pw, height: ph } = page.getSize();
    const EXPORT_SCALE = 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(pw * EXPORT_SCALE);
    canvas.height = Math.floor(ph * EXPORT_SCALE);
    drawAnnotations(canvas.getContext('2d'), ann, EXPORT_SCALE);

    const pngBytes = await new Promise(res =>
      canvas.toBlob(b => b.arrayBuffer().then(res), 'image/png'));
    const png = await pdfDoc.embedPng(pngBytes);
    page.drawImage(png, { x: 0, y: 0, width: pw, height: ph });
  }
  return pdfDoc.save();
}

async function shareDoc(doc) {
  try {
    showToast('PDFを書き出しています…');
    const bytes = await exportAnnotatedPdf(doc);
    const file = new File([bytes], `${doc.name}_注釈付き.pdf`, { type: 'application/pdf' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: doc.name });
    } else {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      showToast('注釈付きPDFをダウンロードしました');
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // 共有キャンセル
    console.error(err);
    showToast('共有に失敗しました');
  }
}

$('shareBtn').addEventListener('click', async () => {
  clearTimeout(saveTimer);
  state.doc.updatedAt = Date.now();
  await dbPut(state.doc);
  shareDoc(state.doc);
});

// 印刷: 注釈付きPDFを生成し、印刷ダイアログを開く
async function printDoc(doc) {
  let url = null;
  try {
    showToast('印刷を準備しています…');
    const bytes = await exportAnnotatedPdf(doc);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    url = URL.createObjectURL(blob);
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.src = url;
    document.body.appendChild(iframe);
    iframe.onload = () => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (_) {
        // 印刷をフレーム内で起動できない端末は新しいタブで開く
        window.open(url, '_blank');
      }
    };
    // 後片付け(印刷ダイアログが閉じた後を想定して遅延解放)
    setTimeout(() => { iframe.remove(); URL.revokeObjectURL(url); }, 60000);
  } catch (err) {
    console.error(err);
    if (url) URL.revokeObjectURL(url);
    showToast('印刷の準備に失敗しました');
  }
}

$('printBtn').addEventListener('click', async () => {
  clearTimeout(saveTimer);
  state.doc.updatedAt = Date.now();
  await dbPut(state.doc);
  printDoc(state.doc);
});

/* ================= リアルタイム共同編集(フォルダ単位) ================= */
// 共有中の各フォルダ(shareCode)ごとに常時接続を維持する
const conns = new Map(); // code -> { ws, retry, recreateAttempts, members, offline }

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function base64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// エディタヘッダーのバッジ: 開いている文書のフォルダの接続状態を表示
function applySyncUI() {
  const ed = $('shareState');
  if (views.editor.hidden || !state.doc || !state.doc.shareCode) { ed.hidden = true; return; }
  const c = conns.get(state.doc.shareCode);
  ed.hidden = false;
  if (!c || c.offline) { ed.textContent = '共有 再接続中…'; ed.classList.add('offline'); }
  else { ed.textContent = `● 共有中 ${c.members || 1}台`; ed.classList.remove('offline'); }
}

let pendingOps = []; // サーバーがACKを返すまで保持する操作(再接続時に再送)。各entryに code を持つ
let opSeq = 0;

function sendOp(page, op) {
  if (!state.doc || !state.doc.shareCode || !state.doc.remoteId) return;
  const code = state.doc.shareCode;
  const entry = { seq: ++opSeq, code, docId: state.doc.remoteId, page, op };
  pendingOps.push(entry);
  const c = conns.get(code);
  if (c && c.ws && c.ws.readyState === WebSocket.OPEN) {
    c.ws.send(JSON.stringify({ type: 'op', seq: entry.seq, docId: entry.docId, page, op }));
  }
}
function sendPageSet(page) {
  if (!state.doc) return;
  sendOp(page, { kind: 'page:set', ann: pageAnn(state.doc, page) });
}

function applyRemoteOp(page, op) {
  if (!state.doc) return;
  if (op.kind === 'stroke:add') pageAnn(state.doc, page).strokes.push(op.stroke);
  else if (op.kind === 'page:set') state.doc.annotations[page] = op.ann;
  const info = state.pages.find(p => p.num === Number(page));
  if (info) redrawOverlay(info);
  scheduleSave();
}

// 開いていない同タイトル内の文書への操作をローカル保存分に反映
async function applyOpToDb(shareCode, remoteId, page, op) {
  const doc = (await dbAll()).find(d => d.shareCode === shareCode && d.remoteId === remoteId);
  if (!doc) return;
  if (!doc.annotations[page]) doc.annotations[page] = { strokes: [], texts: [] };
  if (op.kind === 'stroke:add') doc.annotations[page].strokes.push(op.stroke);
  else if (op.kind === 'page:set') doc.annotations[page] = op.ann;
  doc.updatedAt = Date.now();
  await dbPut(doc);
}

// doc:add通知: 共有タイトルに追加された文書を受信
async function receiveSharedDoc(shareCode, remoteId) {
  const all = await dbAll();
  if (all.some(d => d.shareCode === shareCode && d.remoteId === remoteId)) return;
  const sibling = all.find(d => d.shareCode === shareCode);
  try {
    const res = await fetch(`/api/share/${shareCode}/docs/${encodeURIComponent(remoteId)}`);
    if (!res.ok) return;
    const data = await res.json();
    const pdfData = base64ToBuf(data.pdf);
    const pdf = await pdfjsLib.getDocument({ data: pdfData.slice(0) }).promise;
    const doc = {
      id: 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: data.name,
      category: data.category || (sibling ? (sibling.category || '未分類') : '未分類'),
      pdfData,
      annotations: data.annotations || {},
      pageCount: pdf.numPages,
      shareCode,
      remoteId,
      updatedAt: Date.now()
    };
    await pdf.destroy();
    await dbPut(doc);
    showToast(`共有文書「${data.name}」が追加されました`);
    if (!views.home.hidden) renderHome();
  } catch (err) {
    console.error('共有文書の受信に失敗:', err);
  }
}

// doc:rename通知: 共有相手が変更した文書名をローカルに反映
async function renameLocalDoc(shareCode, remoteId, name) {
  const d = (await dbAll()).find(x => x.shareCode === shareCode && x.remoteId === remoteId);
  if (!d || d.name === name) return;
  d.name = name;
  await dbPut(d);
  if (state.doc && state.doc.id === d.id) {
    state.doc.name = name;
    $('docTitle').textContent = name;
  }
  if (!views.home.hidden) renderHome();
}

// doc:delete通知: 共有相手が削除した文書をローカルからも削除
async function deleteLocalDoc(shareCode, remoteId) {
  const d = (await dbAll()).find(x => x.shareCode === shareCode && x.remoteId === remoteId);
  if (!d) return;
  // 自分がその文書を開いていたらホームへ戻す(同期接続は維持)
  if (state.doc && state.doc.id === d.id) {
    backToHome();
    showToast(`他の端末で「${d.name}」が削除されました`);
    await dbDelete(d.id);
    renderHome();
    return;
  }
  await dbDelete(d.id);
  if (!views.home.hidden) renderHome();
}

function libDocPayload(d) {
  return { id: d.remoteId || d.id, name: d.name, category: d.category || '未分類', pdf: bufToBase64(d.pdfData), annotations: d.annotations };
}

// 共有中の全フォルダ(distinct shareCode)へ接続を維持。不要な接続は閉じる。
async function ensureConnections() {
  const docs = await dbAll();
  const codes = new Set(docs.filter(d => d.shareCode && d.remoteId).map(d => d.shareCode));
  for (const code of [...conns.keys()]) if (!codes.has(code)) closeConn(code);
  for (const code of codes) if (!conns.has(code)) connectRoom(code);
}

function closeConn(code) {
  const c = conns.get(code);
  if (!c) return;
  clearTimeout(c.retry);
  if (c.ws) { const s = c.ws; c.ws = null; s.close(); }
  conns.delete(code);
}

// 1つのフォルダ(code)への常時接続。openEditor/戻る では切断しない。
function connectRoom(code) {
  const existing = conns.get(code);
  if (existing && existing.ws && existing.ws.readyState <= 1) return; // 接続済み
  const c = conns.get(code) || { ws: null, retry: null, recreateAttempts: 0, members: 1, offline: true };
  conns.set(code, c);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws?code=${code}&name=${encodeURIComponent(getGuestName())}`);
  c.ws = sock;

  sock.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'init') {
      const all = msg.annotations || {};
      const dn = msg.docNames || {};
      const del = msg.deleted || [];
      for (const entry of pendingOps.filter(p => p.code === code)) {
        sock.send(JSON.stringify({ type: 'op', seq: entry.seq, docId: entry.docId, page: entry.page, op: entry.op }));
        if (state.doc && state.doc.shareCode === code && entry.docId === state.doc.remoteId) applyRemoteOp(entry.page, entry.op);
      }
      (async () => {
        const all2 = await dbAll();
        for (const s of all2.filter(d => d.shareCode === code && d.remoteId)) {
          if (del.includes(s.remoteId)) {
            if (state.doc && state.doc.id === s.id) { backToHome(); showToast(`「${s.name}」は他の端末で削除されました`); }
            await dbDelete(s.id);
            continue;
          }
          let dirty = false;
          if (all[s.remoteId] && JSON.stringify(s.annotations) !== JSON.stringify(all[s.remoteId])) { s.annotations = all[s.remoteId]; dirty = true; }
          if (dn[s.remoteId] && dn[s.remoteId] !== s.name) { s.name = dn[s.remoteId]; dirty = true; }
          if (dirty) await dbPut(s);
        }
        if (state.doc && state.doc.shareCode === code && all[state.doc.remoteId]) {
          state.doc.annotations = all[state.doc.remoteId];
          state.pages.forEach(redrawOverlay);
        }
        if (state.doc && state.doc.shareCode === code && dn[state.doc.remoteId] && dn[state.doc.remoteId] !== state.doc.name) {
          state.doc.name = dn[state.doc.remoteId]; $('docTitle').textContent = state.doc.name;
        }
        if (!views.home.hidden) renderHome();
      })();
      c.recreateAttempts = 0; c.offline = false; c.members = msg.members;
      applySyncUI();
    } else if (msg.type === 'ack') {
      pendingOps = pendingOps.filter(p => p.seq !== msg.seq);
    } else if (msg.type === 'members') {
      c.members = msg.count; applySyncUI(); if (!views.home.hidden) renderHome();
    } else if (msg.type === 'op') {
      if (state.doc && state.doc.shareCode === code && msg.docId === state.doc.remoteId) applyRemoteOp(msg.page, msg.op);
      else applyOpToDb(code, msg.docId, msg.page, msg.op);
    } else if (msg.type === 'doc:add') {
      receiveSharedDoc(code, msg.docId);
    } else if (msg.type === 'doc:rename') {
      renameLocalDoc(code, msg.docId, msg.name);
    } else if (msg.type === 'doc:delete') {
      deleteLocalDoc(code, msg.docId);
    }
  };

  sock.onclose = (e) => {
    if (c.ws !== sock) return; // 意図的な切断
    c.ws = null; c.offline = true;
    if (!conns.has(code)) return; // 共有解除済み
    applySyncUI();
    if (e.code === 4404) {
      // サーバーからルームが消えている → 復元を試みて再接続(成功するまで諦めない)
      c.recreateAttempts = (c.recreateAttempts || 0) + 1;
      const backoff = Math.min(15000, 1500 * c.recreateAttempts); // 失敗時は徐々に間隔を空ける(最大15秒)
      recreateRoom(code).then((ok) => {
        c.retry = setTimeout(() => connectRoom(code), ok ? 600 : backoff);
      });
      return;
    }
    c.retry = setTimeout(() => connectRoom(code), 2500);
  };
  sock.onerror = () => sock.close();
}

// 消えたフォルダのルームを手元の文書から同じコードで再作成(自己修復)
// 大きいPDFや多数の文書でも通るよう、1件ずつ分割アップロードする
async function recreateRoom(code) {
  try {
    const docs = (await dbAll()).filter(d => d.shareCode === code && d.remoteId);
    if (!docs.length) return false;
    const name = docs[0].category || '共有';
    // まず1文書だけでルーム作成(巨大な単一リクエストを避ける)
    const first = await fetch('/api/share', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name, docs: [libDocPayload(docs[0])] })
    });
    if (!first.ok) { console.error('共有の復元に失敗:', first.status); return false; }
    // 残りは1件ずつ追加(1件失敗しても続行)
    for (const d of docs.slice(1)) {
      try {
        await fetch(`/api/share/${code}/docs`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(libDocPayload(d))
        });
      } catch (_) {}
    }
    return true;
  } catch (err) { console.error('共有の復元に失敗:', err); return false; }
}

// 取り込んだ文書を、そのフォルダが共有中なら自動でルームに追加・配信
async function addDocToFolderShare(doc) {
  const code = doc.shareCode;
  if (!code || !doc.remoteId) return;
  try {
    const res = await fetch(`/api/share/${code}/docs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(libDocPayload(doc))
    });
    if (res.status === 404) await recreateRoom(code);
  } catch (_) {}
}

// フォルダ(タイトル)単位で共有を開始。1フォルダ = 1コード
async function shareFolder(category) {
  const docs = (await dbAll()).filter(d => (d.category || '未分類') === category);
  if (!docs.length) throw new Error('文書がありません');
  const already = docs.find(d => d.shareCode);
  if (already) {
    // 既に共有中: 未登録の文書だけ追加
    for (const d of docs.filter(x => !x.shareCode)) {
      d.shareCode = already.shareCode; d.remoteId = d.id; await dbPut(d);
      await addDocToFolderShare(d);
    }
    ensureConnections();
    return already.shareCode;
  }
  showToast('共有を準備しています…');
  const res = await fetch('/api/share', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: category, docs: docs.map(d => ({ ...libDocPayload(d), id: d.id })) })
  });
  if (!res.ok) throw new Error('share failed: ' + res.status);
  const { code } = await res.json();
  for (const d of docs) { d.shareCode = code; d.remoteId = d.id; await dbPut(d); }
  ensureConnections();
  renderHome();
  return code;
}

// コードでフォルダ共有に参加(相手の文書を受信し、そのフォルダに入れる)
async function joinFolder(codeInput) {
  const code = (codeInput || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) { showToast('6桁のコードを入力してください'); return; }
  showToast('共有フォルダを取得しています…');
  const res = await fetch('/api/share/' + code);
  if (!res.ok) { showToast('コードが見つかりません'); return; }
  const data = await res.json();
  const local = await dbAll();
  const folderName = data.name || '共有';
  let added = 0;
  for (const rd of data.docs) {
    if (local.some(d => d.remoteId === rd.id && d.shareCode === code)) continue;
    const pdfData = base64ToBuf(rd.pdf);
    const pdf = await pdfjsLib.getDocument({ data: pdfData.slice(0) }).promise;
    await dbPut({
      id: 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: rd.name, category: rd.category || folderName, pdfData,
      annotations: rd.annotations || {}, pageCount: pdf.numPages,
      shareCode: code, remoteId: rd.id, updatedAt: Date.now()
    });
    await pdf.destroy();
    added++;
  }
  ensureConnections();
  showToast(added ? `共有フォルダ「${folderName}」に参加しました(${added}件)` : 'すでに参加済みです');
  renderHome();
}

// フォルダの共有を解除(この端末だけ。文書は残す)
async function unshareFolder(category) {
  const docs = (await dbAll()).filter(d => (d.category || '未分類') === category && d.shareCode);
  const codes = new Set(docs.map(d => d.shareCode));
  for (const d of docs) { delete d.shareCode; delete d.remoteId; await dbPut(d); }
  for (const code of codes) closeConn(code);
  renderHome();
  showToast('このフォルダの共有を解除しました(文書は残ります)');
}

/* ---- 共有コードダイアログ ---- */
let dialogCategory = null;
function showShareDialog(code, category) {
  dialogCategory = category;
  $('shareCodeDisplay').textContent = code;
  $('shareDialog').hidden = false;
}
$('shareCloseBtn').addEventListener('click', () => { $('shareDialog').hidden = true; });
$('shareCopyBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('shareCodeDisplay').textContent); showToast('コードをコピーしました'); }
  catch { showToast('コピーできませんでした'); }
});
$('shareStopBtn').addEventListener('click', () => {
  $('shareDialog').hidden = true;
  if (dialogCategory && confirm('このフォルダの共有を解除しますか？')) unshareFolder(dialogCategory);
});

// エディタの🔗: 今開いている文書のフォルダを共有/コード表示
$('liveBtn').addEventListener('click', async () => {
  if (!state.doc) return;
  const cat = state.doc.category || '未分類';
  try {
    if (state.doc.shareCode) { showShareDialog(state.doc.shareCode, cat); }
    else { const code = await shareFolder(cat); showShareDialog(code, cat); applySyncUI(); }
  } catch (err) { console.error(err); showToast('共有サーバーに接続できません'); }
});

// ホームの「コードで参加」
$('joinBtn').addEventListener('click', () => {
  const code = prompt('共有コードを入力(6桁)');
  if (code) joinFolder(code).catch(err => { console.error(err); showToast('参加に失敗しました'); });
});

/* ---- 一括選択・削除 ---- */
$('selectBtn').addEventListener('click', () => {
  selectMode = !selectMode;
  selectedIds.clear();
  renderHome();
});
$('bulkCancel').addEventListener('click', () => {
  selectMode = false;
  selectedIds.clear();
  renderHome();
});
$('bulkSelectAll').addEventListener('click', async () => {
  const all = await dbAll();
  if (selectedIds.size === all.length) selectedIds.clear(); // 全選択済みなら全解除
  else for (const d of all) selectedIds.add(d.id);
  renderHome();
});
$('bulkDelete').addEventListener('click', async () => {
  if (selectedIds.size === 0) return;
  if (!confirm(`選択した ${selectedIds.size} 件を削除しますか？(共有中のものは相手の端末からも削除されます)`)) return;
  const all = await dbAll();
  const docs = all.filter(d => selectedIds.has(d.id));
  await deleteDocs(docs);
  selectMode = false;
  selectedIds.clear();
  showToast(`${docs.length}件を削除しました`);
  renderHome();
});

/* ================= PWA ================= */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* テスト用フック */
window.__app = { importPdf, openEditor, renderHome, state, dbAll, exportAnnotatedPdf, shareFolder, joinFolder, unshareFolder, conns };

/* ================= 起動 ================= */
function hideSplash() {
  const s = $('splash');
  if (!s) return;
  s.classList.add('hide');
  setTimeout(() => s.remove(), 600);
}

setupPinchZoom();
// アプリが前面に復帰/再表示されたら固まり状態を解除
// (iOSはPWAを再読込せず復帰するため、落として開き直しても残骸が残ることがある)
document.addEventListener('visibilitychange', () => { if (!document.hidden) resetGestureState(); });
window.addEventListener('focus', resetGestureState);
window.addEventListener('pageshow', resetGestureState);
const splashStart = Date.now();
Promise.resolve(renderHome()).finally(() => {
  // 最低0.7秒は表示してチラつきを防ぐ
  setTimeout(hideSplash, Math.max(0, 700 - (Date.now() - splashStart)));
});
// 念のための保険(何かで止まっても3秒で必ず消す)
setTimeout(hideSplash, 3000);
// 共有中の各フォルダへ常時接続を開始
ensureConnections();
// 接続が落ちていたら定期的に張り直す(保険)
setInterval(ensureConnections, 8000);
