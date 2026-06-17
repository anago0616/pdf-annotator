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
  pinching: false   // 2本指ピンチ操作中
};

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
async function renderHome() {
  views.editor.hidden = true;
  views.home.hidden = false;
  const docs = (await dbAll()).sort((a, b) => b.updatedAt - a.updatedAt);
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
    const header = document.createElement('div');
    header.className = 'cat-header';
    header.innerHTML = `<span class="cat-arrow">${isClosed ? '▶' : '▼'}</span>📁 <span class="cat-name"></span><span class="cat-count">${items.length}</span><span class="spacer"></span><button class="cat-share-btn${groupCode ? ' shared' : ''}">${groupCode ? '🔗 ' + groupCode : '🔗 共有'}</button>`;
    header.querySelector('.cat-name').textContent = cat;
    header.addEventListener('click', () => {
      if (collapsed.has(cat)) collapsed.delete(cat);
      else collapsed.add(cat);
      localStorage.setItem('pdfnote_collapsed', JSON.stringify([...collapsed]));
      renderHome();
    });
    header.querySelector('.cat-share-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        if (groupCode) {
          showShareDialog(groupCode);
        } else {
          if (!confirm(`「${cat}」の${items.length}件の文書を共有しますか？`)) return;
          const code = await startGroupShare(cat);
          showShareDialog(code);
          renderHome();
        }
      } catch (err) {
        console.error(err);
        showToast('共有サーバーに接続できません');
      }
    });
    list.appendChild(header);
    if (isClosed) continue;

    for (const d of items) {
      const card = document.createElement('div');
      card.className = 'doc-card';
      card.innerHTML = `
        <div class="doc-icon">📄</div>
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
            }).then(res => { if (res.status === 404) recreateRoom(d); }).catch(() => {});
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
          // 共有中なら相手の端末からも削除
          if (d.shareCode && d.remoteId) {
            fetch(`/api/share/${d.shareCode}/docs/${encodeURIComponent(d.remoteId)}`, { method: 'DELETE' }).catch(() => {});
          }
          await dbDelete(d.id);
          renderHome();
        }
      });
      list.appendChild(card);
    }
  }
  syncSharedNames(); // 共有中の文書名をサーバーから取得して反映(一覧画面でも最新に)
}

// 共有中の各タイトルの最新の文書名をサーバーから取得してローカルに反映
let lastNameSync = 0;
async function syncSharedNames() {
  if (Date.now() - lastNameSync < 2500) return; // 連続呼び出しを抑制
  lastNameSync = Date.now();
  const docs = await dbAll();
  const codes = [...new Set(docs.filter(d => d.shareCode && d.remoteId).map(d => d.shareCode))];
  let changed = false;
  for (const code of codes) {
    try {
      const res = await fetch(`/api/share/${code}/meta`);
      if (!res.ok) continue;
      const meta = await res.json();
      const deleted = meta.deleted || [];
      for (const d of docs.filter(x => x.shareCode === code && x.remoteId)) {
        if (deleted.includes(d.remoteId)) {
          // 相手が削除した文書をローカルからも削除
          await dbDelete(d.id);
          changed = true;
          continue;
        }
        const sName = meta.docs[d.remoteId];
        if (sName && sName !== d.name) { d.name = sName; await dbPut(d); changed = true; }
      }
    } catch {}
  }
  if (changed && !views.home.hidden) renderHome();
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
  // 取り込み先タイトルが共有中なら、新しい文書も自動で共有に追加
  const sharedDoc = (await dbAll()).find(d => (d.category || '未分類') === category && d.shareCode);
  let ok = 0, fail = 0, lastDoc = null;
  for (const file of files) {
    try {
      lastDoc = await importPdf(file.name, await file.arrayBuffer(), category);
      if (sharedDoc) await uploadDocToRoom(sharedDoc.shareCode, lastDoc);
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
  pendingOps = [];
  $('docTitle').textContent = doc.name;
  $('saveStatus').textContent = '';
  views.home.hidden = true;
  views.editor.hidden = false;
  if (doc.shareCode && !doc.remoteId) doc.remoteId = 'doc_legacy'; // 旧形式(文書単位共有)からの移行
  if (doc.shareCode) connectShare(doc);
  else setShareState(null);
  state.pdf = await pdfjsLib.getDocument({ data: doc.pdfData.slice(0) }).promise;
  await renderAllPages();
  setTool('hand');
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

    // 実効解像度: 端末DPRを基準に少しオーバーサンプルしつつ、上限を超えないよう制限
    let dpr = baseDpr * OVERSAMPLE;
    dpr = Math.min(dpr, Math.sqrt(MAX_AREA / (vp.width * vp.height)));
    dpr = Math.min(dpr, MAX_DIM / vp.width, MAX_DIM / vp.height);
    dpr = Math.max(1, dpr); // 最低でも等倍は確保

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
    t.text.split('\n').forEach((line, i) => {
      ctx.fillText(line, t.x * factor, (t.y + i * t.size * 1.3) * factor);
    });
    ctx.restore();
  }
}

function redrawOverlay(info) {
  const ctx = info.overlay.getContext('2d');
  ctx.clearRect(0, 0, info.overlay.width, info.overlay.height);
  const ann = pageAnn(state.doc, info.num);
  drawAnnotations(ctx, ann, info.scale * info.dpr);
}

/* ---- ポインタ操作 ---- */
function attachPointerHandlers(info) {
  const ov = info.overlay;
  let stroke = null;

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
    if (state.tool === 'hand' || state.pinching || e.pointerType === 'touch' && activeTouchCount() >= 2) return;
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
      handleTextTap(info, x, y);
    }
  });

  ov.addEventListener('pointermove', (e) => {
    if (state.tool === 'hand') return;
    if (state.pinching) { stroke = null; return; }
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
function handleTextTap(info, x, y) {
  const ann = pageAnn(state.doc, info.num);
  // 既存テキストをタップしたら編集
  const idx = ann.texts.findIndex(t => {
    const lines = t.text.split('\n');
    const h = lines.length * t.size * 1.3;
    const w = Math.max(...lines.map(l => l.length)) * t.size;
    return x >= t.x && x <= t.x + w && y >= t.y && y <= t.y + h;
  });
  if (idx >= 0) {
    state.editingText = { page: info.num, index: idx };
    $('textInput').value = ann.texts[idx].text;
    $('textDeleteBtn').hidden = false;
  } else {
    state.editingText = { page: info.num, x, y };
    $('textInput').value = '';
    $('textDeleteBtn').hidden = true;
  }
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
    if (text) ann.texts[et.index].text = text;
    else ann.texts.splice(et.index, 1);
  } else if (text) {
    ann.texts.push({ x: et.x, y: et.y, text, color: state.color, size: Math.max(10, state.width * 4) });
  }
  const info = state.pages.find(p => p.num === et.page);
  if (info) redrawOverlay(info);
  scheduleSave();
  sendPageSet(et.page);
  closeTextEditor();
});
$('textCancelBtn').addEventListener('click', closeTextEditor);
$('textDeleteBtn').addEventListener('click', () => {
  const et = state.editingText;
  if (et && et.index != null) {
    pushUndo(et.page);
    pageAnn(state.doc, et.page).texts.splice(et.index, 1);
    const info = state.pages.find(p => p.num === et.page);
    if (info) redrawOverlay(info);
    scheduleSave();
    sendPageSet(et.page);
  }
  closeTextEditor();
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
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === tool));
  updateOverlayInteractivity();
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
const ZOOM_MIN = 0.5, ZOOM_MAX = 8;
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
const touchPts = new Map(); // pointerId -> {x, y}  ※指の本数管理
function activeTouchCount() { return touchPts.size; }

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
    if (e.pointerType === 'touch') touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }, true);
  const dropPt = (e) => { if (e.pointerType === 'touch') touchPts.delete(e.pointerId); };
  container.addEventListener('pointerup', dropPt, true);
  container.addEventListener('pointercancel', dropPt, true);
}

/* ---- 戻る ---- */
$('backBtn').addEventListener('click', async () => {
  clearTimeout(saveTimer);
  disconnectShare();
  state.doc.updatedAt = Date.now();
  await dbPut(state.doc);
  if (state.pdf) { await state.pdf.destroy(); state.pdf = null; }
  state.doc = null;
  renderHome();
});

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

/* ================= リアルタイム共同編集 ================= */
let ws = null;
let wsRetryTimer = null;
let recreateAttempts = 0; // ルーム自己修復の試行回数(init成功でリセット)

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

function setShareState(text, offline = false, names = null) {
  const el = $('shareState');
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = text;
  el.title = names ? '参加中: ' + names.join('、') : '';
  el.classList.toggle('offline', offline);
}

let pendingOps = []; // サーバーがACKを返すまで保持する操作(再接続時に再送)
let opSeq = 0;

function sendOp(page, op) {
  if (!state.doc || !state.doc.shareCode || !state.doc.remoteId) return;
  const entry = { seq: ++opSeq, docId: state.doc.remoteId, page, op };
  pendingOps.push(entry);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'op', seq: entry.seq, docId: entry.docId, page, op }));
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
      category: sibling ? (sibling.category || '未分類') : '共有',
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
  // 自分がその文書を開いていたらホームへ戻す
  if (state.doc && state.doc.id === d.id) {
    disconnectShare();
    if (state.pdf) { try { await state.pdf.destroy(); } catch (_) {} state.pdf = null; }
    state.doc = null;
    showToast(`共有相手が「${d.name}」を削除しました`);
    await dbDelete(d.id);
    renderHome();
    return;
  }
  await dbDelete(d.id);
  if (!views.home.hidden) renderHome();
}

function connectShare(doc) {
  disconnectShare();
  setShareState('接続中…');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws?code=${doc.shareCode}&name=${encodeURIComponent(getGuestName())}`);
  ws = sock;

  sock.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'init') {
      // サーバー側の注釈を正として反映(ルームはタイトル単位: docIdごとの注釈)
      const all = msg.annotations || {};
      state.doc.annotations = all[state.doc.remoteId] || {};
      // 未ACKの自分の操作を再適用して再送
      for (const entry of pendingOps) {
        if (entry.docId === state.doc.remoteId) applyRemoteOp(entry.page, entry.op);
        sock.send(JSON.stringify({ type: 'op', seq: entry.seq, docId: entry.docId, page: entry.page, op: entry.op }));
      }
      state.pages.forEach(redrawOverlay);
      scheduleSave();
      // 同タイトルの他文書の注釈・名前・削除をローカルに反映
      const dn = msg.docNames || {};
      const del = msg.deleted || [];
      (async () => {
        const all2 = await dbAll();
        for (const s of all2.filter(d => d.shareCode === doc.shareCode && d.id !== doc.id && d.remoteId)) {
          if (del.includes(s.remoteId)) { await dbDelete(s.id); continue; } // 相手が削除
          if (!all[s.remoteId]) continue;
          s.annotations = all[s.remoteId];
          if (dn[s.remoteId]) s.name = dn[s.remoteId];
          await dbPut(s);
        }
        if (!views.home.hidden) renderHome();
      })();
      // 開いている文書の名前もサーバーに合わせる
      if (dn[state.doc.remoteId] && dn[state.doc.remoteId] !== state.doc.name) {
        state.doc.name = dn[state.doc.remoteId];
        $('docTitle').textContent = state.doc.name;
        dbPut(state.doc);
      }
      recreateAttempts = 0; // 接続成功 → 復元カウンタをリセット
      setShareState(`● 共有中 ${msg.members}人`, false, msg.names);
    } else if (msg.type === 'ack') {
      pendingOps = pendingOps.filter(p => p.seq !== msg.seq);
    } else if (msg.type === 'members') {
      setShareState(`● 共有中 ${msg.count}人`, false, msg.names);
    } else if (msg.type === 'op') {
      if (state.doc && msg.docId === state.doc.remoteId) applyRemoteOp(msg.page, msg.op);
      else applyOpToDb(doc.shareCode, msg.docId, msg.page, msg.op);
    } else if (msg.type === 'doc:add') {
      receiveSharedDoc(doc.shareCode, msg.docId);
    } else if (msg.type === 'doc:rename') {
      renameLocalDoc(doc.shareCode, msg.docId, msg.name);
    } else if (msg.type === 'doc:delete') {
      deleteLocalDoc(doc.shareCode, msg.docId);
    }
  };

  sock.onclose = (e) => {
    if (ws !== sock) return; // 意図的な切断
    ws = null;
    if (e.code === 4404) {
      // サーバーからルームが消えている(無料プランの再起動等)→ 手元のデータから自動復元
      if (recreateAttempts < 3 && state.doc && state.doc.shareCode) {
        recreateAttempts++;
        setShareState('共有を復元中…', true);
        recreateRoom(state.doc).then(ok => {
          if (ok && state.doc && state.doc.shareCode) connectShare(state.doc);
          else { setShareState('共有エラー', true); showToast('共有の復元に失敗しました'); }
        });
      } else {
        setShareState('共有エラー', true);
      }
      return;
    }
    if (state.doc && state.doc.shareCode) {
      setShareState('再接続中…', true);
      wsRetryTimer = setTimeout(() => connectShare(state.doc), 2500);
    }
  };
  sock.onerror = () => sock.close();
}

// 消えたルームを手元の文書から同じコードで再作成(自己修復)
async function recreateRoom(doc) {
  try {
    const docs = (await dbAll()).filter(d => d.shareCode === doc.shareCode);
    if (!docs.length) return false;
    const res = await fetch('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: doc.shareCode,
        name: doc.category || '共有',
        docs: docs.map(d => ({
          id: d.remoteId || d.id,
          name: d.name,
          pdf: bufToBase64(d.pdfData),
          annotations: d.annotations
        }))
      })
    });
    return res.ok;
  } catch (err) {
    console.error('共有の復元に失敗:', err);
    return false;
  }
}

function disconnectShare() {
  clearTimeout(wsRetryTimer);
  if (ws) { const s = ws; ws = null; s.close(); }
  setShareState(null);
}

// 共有中のタイトルへ1文書を追加(ルームが消えていれば自動復元される)
async function uploadDocToRoom(code, doc) {
  const res = await fetch(`/api/share/${code}/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: doc.id,
      name: doc.name,
      pdf: bufToBase64(doc.pdfData),
      annotations: doc.annotations
    })
  });
  if (res.status === 404) {
    // ルームが消えている → タイトル全体を同じコードで作り直し
    doc.shareCode = code; doc.remoteId = doc.id; await dbPut(doc);
    await recreateRoom(doc);
  } else if (!res.ok) {
    throw new Error('upload failed: ' + res.status);
  }
  doc.shareCode = code;
  doc.remoteId = doc.id;
  await dbPut(doc);
}

// タイトル(フォルダ)単位で共有を開始。1タイトル = 1コード
async function startGroupShare(category) {
  const docs = (await dbAll()).filter(d => (d.category || '未分類') === category);
  if (!docs.length) throw new Error('文書がありません');

  // すでに共有中なら、未共有の文書だけ追加(ルームが消えていれば復元される)
  const shared = docs.find(d => d.shareCode);
  if (shared) {
    for (const d of docs.filter(x => !x.shareCode)) await uploadDocToRoom(shared.shareCode, d);
    return shared.shareCode;
  }

  showToast('共有を準備しています…');
  const res = await fetch('/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: category,
      docs: docs.map(d => ({
        id: d.id,
        name: d.name,
        pdf: bufToBase64(d.pdfData),
        annotations: d.annotations
      }))
    })
  });
  if (!res.ok) throw new Error('share failed: ' + res.status);
  const { code } = await res.json();
  for (const d of docs) {
    d.shareCode = code;
    d.remoteId = d.id;
    await dbPut(d);
  }
  return code;
}

async function joinByCode(codeInput) {
  const code = codeInput.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) { showToast('6桁の共有コードを入力してください'); return; }
  showToast('文書を取得しています…');
  const res = await fetch('/api/share/' + code);
  if (!res.ok) { showToast('共有コードが見つかりません'); return; }
  const data = await res.json();
  const existing = (await dbAll()).filter(d => d.shareCode === code);
  let added = 0;
  for (const rd of data.docs) {
    if (existing.some(d => d.remoteId === rd.id)) continue;
    const pdfData = base64ToBuf(rd.pdf);
    const pdf = await pdfjsLib.getDocument({ data: pdfData.slice(0) }).promise;
    const doc = {
      id: 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: rd.name,
      category: data.name || '共有',
      pdfData,
      annotations: rd.annotations || {},
      pageCount: pdf.numPages,
      shareCode: code,
      remoteId: rd.id,
      updatedAt: Date.now()
    };
    await pdf.destroy();
    await dbPut(doc);
    added++;
  }
  showToast(added ? `「${data.name}」の文書 ${data.docs.length}件 を受信しました` : 'すでに参加済みのタイトルです');
  renderHome();
}

function showShareDialog(code) {
  $('shareCodeDisplay').textContent = code;
  $('shareDialog').hidden = false;
}
$('shareCloseBtn').addEventListener('click', () => { $('shareDialog').hidden = true; });
$('shareCopyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('shareCodeDisplay').textContent);
    showToast('コードをコピーしました');
  } catch {
    showToast('コピーできませんでした');
  }
});

$('liveBtn').addEventListener('click', async () => {
  if (!state.doc) return;
  try {
    if (!state.doc.shareCode) {
      const code = await startGroupShare(state.doc.category || '未分類');
      state.doc.shareCode = code;
      state.doc.remoteId = state.doc.id;
      await dbPut(state.doc);
      connectShare(state.doc);
      showShareDialog(code);
    } else {
      showShareDialog(state.doc.shareCode);
    }
  } catch (err) {
    console.error(err);
    showToast('共有サーバーに接続できません');
  }
});

$('joinBtn').addEventListener('click', () => {
  const code = prompt('共有コードを入力してください(6桁)');
  if (code) joinByCode(code).catch(err => {
    console.error(err);
    showToast('参加に失敗しました');
  });
});

/* ================= PWA ================= */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* テスト用フック */
window.__app = { importPdf, openEditor, renderHome, state, dbAll, exportAnnotatedPdf, startGroupShare, joinByCode };

/* ================= 起動 ================= */
setupPinchZoom();
renderHome();
// ホーム表示中は定期的に共有中の文書名を取得して最新に保つ
setInterval(() => { if (!views.home.hidden) syncSharedNames(); }, 6000);
