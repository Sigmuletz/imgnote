// imgnote — slice.js
// Clipboard image import. Paste an image, cut it with vertical and horizontal
// guides, pick which of the resulting cells you want, and write those cells
// into the served folder as individual PNG files.
//
// Loaded on demand by app.js the first time an image is pasted. Owns its own
// DOM: the overlay is built here and appended to <body>, so the module drops
// into any page that loaded app.js without markup changes.

import { refreshFiles, setModalOpen, setStatus } from './app.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_GUIDES = 63;   // per axis -> at most 64 columns / 64 rows
const MAX_SLICES = 512;  // must not exceed the server's MAX_IMPORT_FILES
const MIN_CELL = 2;      // px in image space; guides closer than this are refused
const RULER = 18;        // px thickness of the click-to-add-a-guide strips

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const S = {
  open: false,
  blobUrl: null,
  img: null,          // HTMLImageElement, source for both display and export
  w: 0,               // natural image size
  h: 0,
  scale: 1,           // display px per image px
  vs: [],             // vertical guides: x positions in image px, sorted
  hs: [],             // horizontal guides: y positions in image px, sorted
  off: new Set(),     // "r:c" of *deselected* cells — new cells default to on
  names: new Map(),   // "r:c" -> custom filename stem chosen by the user
  drag: null,         // active guide drag or cell paint
};

let els = null;       // built once, reused for every paste

const key = (r, c) => `${r}:${c}`;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Cut lines including the image edges: n guides -> n+1 cells.
const xEdges = () => [0, ...S.vs, S.w];
const yEdges = () => [0, ...S.hs, S.h];
const cols = () => S.vs.length + 1;
const rows = () => S.hs.length + 1;

function cellRect(r, c) {
  const xe = xEdges();
  const ye = yEdges();
  return { x: xe[c], y: ye[r], w: xe[c + 1] - xe[c], h: ye[r + 1] - ye[r] };
}

function selectedCells() {
  const out = [];
  for (let r = 0; r < rows(); r++) {
    for (let c = 0; c < cols(); c++) {
      if (!S.off.has(key(r, c))) out.push({ r, c, ...cellRect(r, c) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Guides
// ---------------------------------------------------------------------------

// Moving or adding a guide renumbers every cell after it. Rather than drop the
// user's selection and names, re-anchor them: each entry is remembered by the
// centre point of the cell it described, then reassigned to whichever new cell
// now contains that point.
function withGuidesChanged(mutate) {
  const anchors = [];
  for (let r = 0; r < rows(); r++) {
    for (let c = 0; c < cols(); c++) {
      const k = key(r, c);
      const isOff = S.off.has(k);
      const name = S.names.get(k);
      if (!isOff && name === undefined) continue;
      const rect = cellRect(r, c);
      anchors.push({ px: rect.x + rect.w / 2, py: rect.y + rect.h / 2, isOff, name });
    }
  }

  mutate();

  S.off = new Set();
  S.names = new Map();
  for (const a of anchors) {
    const xe = xEdges();
    const ye = yEdges();
    let c = 0;
    while (c < xe.length - 2 && a.px >= xe[c + 1]) c++;
    let r = 0;
    while (r < ye.length - 2 && a.py >= ye[r + 1]) r++;
    const k = key(r, c);
    if (a.isOff) S.off.add(k);
    if (a.name !== undefined && !S.names.has(k)) S.names.set(k, a.name);
  }
  renderAll(S.drag !== null && S.drag.kind === 'guide');
}

// Guides must stay strictly inside the image and MIN_CELL apart, or a slice
// would come out zero-width and the export would throw.
function canPlace(list, value, ignoreIndex = -1) {
  if (value <= 0 || value >= (list === S.vs ? S.w : S.h)) return false;
  if (value < MIN_CELL || value > (list === S.vs ? S.w : S.h) - MIN_CELL) return false;
  return list.every((g, i) => i === ignoreIndex || Math.abs(g - value) >= MIN_CELL);
}

function addGuide(axis, value) {
  const list = axis === 'v' ? S.vs : S.hs;
  const v = Math.round(value);
  if (list.length >= MAX_GUIDES || !canPlace(list, v)) return;
  withGuidesChanged(() => {
    list.push(v);
    list.sort((a, b) => a - b);
  });
}

function removeGuide(axis, index) {
  const list = axis === 'v' ? S.vs : S.hs;
  if (index < 0 || index >= list.length) return;
  withGuidesChanged(() => list.splice(index, 1));
}

function splitEvenly(nCols, nRows) {
  withGuidesChanged(() => {
    S.vs = [];
    S.hs = [];
    for (let i = 1; i < nCols; i++) {
      const v = Math.round((S.w * i) / nCols);
      if (canPlace(S.vs, v)) S.vs.push(v);
    }
    for (let i = 1; i < nRows; i++) {
      const v = Math.round((S.h * i) / nRows);
      if (canPlace(S.hs, v)) S.hs.push(v);
    }
  });
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

function sanitizeStem(raw) {
  const cleaned = String(raw)
    .replace(/[^A-Za-z0-9 ._-]+/g, '-')  // keep in step with the server's SAFE_NAME_RE
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-{2,}/g, '-')
    .trim()
    .slice(0, 100);
  return cleaned || 'slice';
}

// Auto name: the prefix alone when there is only one slice, otherwise the
// prefix plus its grid position, zero-free and 1-based (`sheet-r2c3.png`).
function autoStem(r, c) {
  const prefix = sanitizeStem(els.prefix.value || 'slice');
  if (rows() === 1 && cols() === 1) return prefix;
  return `${prefix}-r${r + 1}c${c + 1}`;
}

function stemFor(r, c) {
  const custom = S.names.get(key(r, c));
  return custom !== undefined && custom !== '' ? sanitizeStem(custom) : autoStem(r, c);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function sliceToBase64(rect) {
  const resize = els.resizeToggle.checked;
  const dw = resize ? clamp(parseInt(els.resizeW.value, 10) || rect.w, 1, 4096) : rect.w;
  const dh = resize ? clamp(parseInt(els.resizeH.value, 10) || rect.h, 1, 4096) : rect.h;

  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(S.img, rect.x, rect.y, rect.w, rect.h, 0, 0, dw, dh);

  const url = canvas.toDataURL('image/png');
  return url.slice(url.indexOf(',') + 1);
}

async function doImport() {
  const cells = selectedCells();
  if (!cells.length) {
    els.note.textContent = 'Nothing selected.';
    return;
  }
  if (cells.length > MAX_SLICES) {
    els.note.textContent = `Too many slices (${cells.length}, max ${MAX_SLICES}).`;
    return;
  }

  els.importBtn.disabled = true;
  els.note.textContent = `Encoding ${cells.length} slice${cells.length === 1 ? '' : 's'}…`;

  let files;
  try {
    files = cells.map((cell) => ({
      name: `${stemFor(cell.r, cell.c)}.png`,
      data: sliceToBase64(cell),
    }));
  } catch (err) {
    els.note.textContent = `Could not encode the slices: ${err.message}`;
    els.importBtn.disabled = false;
    return;
  }

  try {
    const res = await fetch('/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!res.ok || !data.ok) {
      els.note.textContent = `Import failed: ${data.error || res.status}`;
      els.importBtn.disabled = false;
      return;
    }

    const written = data.written || [];
    close();
    await refreshFiles();
    const renamed = written.filter((n, i) => n !== files[i].name).length;
    setStatus(
      `imported ${written.length} slice${written.length === 1 ? '' : 's'}` +
      (renamed ? ` · ${renamed} renamed to avoid overwriting existing files` : '')
    );
  } catch (err) {
    els.note.textContent = `Import failed: ${err.message}`;
    els.importBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// DOM construction (once)
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function numberInput(id, value, min, max) {
  const input = el('input');
  input.type = 'number';
  input.id = id;
  input.value = String(value);
  input.min = String(min);
  input.max = String(max);
  return input;
}

function build() {
  const overlay = el('div', 'slicer-overlay');
  overlay.hidden = true;

  const dialog = el('div', 'slicer-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Slice pasted image');

  // -- header --
  const head = el('div', 'slicer-head');
  const title = el('div', 'slicer-title', 'Slice pasted image');
  const dims = el('div', 'slicer-dims');
  const closeBtn = el('button', 'slicer-close', '×');
  closeBtn.type = 'button';
  closeBtn.title = 'Close (Esc)';
  head.append(title, dims, closeBtn);

  // -- stage: rulers + image + guides + cells --
  const stage = el('div', 'slicer-stage');
  const frame = el('div', 'slicer-frame');
  const rulerTop = el('div', 'slicer-ruler slicer-ruler-top');
  rulerTop.title = 'Click to add a vertical cut';
  const rulerLeft = el('div', 'slicer-ruler slicer-ruler-left');
  rulerLeft.title = 'Click to add a horizontal cut';
  const plane = el('div', 'slicer-plane');
  const img = el('img', 'slicer-img');
  img.draggable = false;
  img.alt = 'pasted image';
  const cellLayer = el('div', 'slicer-cells');
  const guideLayer = el('div', 'slicer-guides');
  plane.append(img, cellLayer, guideLayer);
  frame.append(rulerTop, rulerLeft, plane);
  stage.append(frame);

  // -- side panel --
  const side = el('div', 'slicer-side');

  const cutSection = el('div', 'slicer-section');
  cutSection.append(el('h3', null, 'Cut'));
  const evenRow = el('div', 'slicer-row');
  const colsInput = numberInput('slicer-cols', 3, 1, MAX_GUIDES + 1);
  const rowsInput = numberInput('slicer-rows', 3, 1, MAX_GUIDES + 1);
  const splitBtn = el('button', null, 'Split');
  splitBtn.type = 'button';
  evenRow.append(el('label', null, 'Cols'), colsInput, el('label', null, 'Rows'), rowsInput, splitBtn);
  const clearBtn = el('button', 'slicer-wide', 'Clear all cuts');
  clearBtn.type = 'button';
  cutSection.append(
    evenRow,
    clearBtn,
    el('p', 'slicer-hint', 'Click a ruler to add one cut. Drag a cut to move it, double-click it to remove it.')
  );

  const pickSection = el('div', 'slicer-section');
  pickSection.append(el('h3', null, 'Slices'));
  const pickRow = el('div', 'slicer-row');
  const allBtn = el('button', null, 'All');
  const noneBtn = el('button', null, 'None');
  const invertBtn = el('button', null, 'Invert');
  for (const b of [allBtn, noneBtn, invertBtn]) b.type = 'button';
  pickRow.append(allBtn, noneBtn, invertBtn);
  pickSection.append(pickRow, el('p', 'slicer-hint', 'Click a slice to include or exclude it; drag to paint.'));

  const nameSection = el('div', 'slicer-section');
  nameSection.append(el('h3', null, 'Names'));
  const prefixRow = el('div', 'slicer-row');
  const prefix = el('input');
  prefix.type = 'text';
  prefix.id = 'slicer-prefix';
  prefix.value = 'slice';
  prefix.spellcheck = false;
  prefixRow.append(el('label', null, 'Prefix'), prefix);
  const resizeRow = el('div', 'slicer-row');
  const resizeToggle = el('input');
  resizeToggle.type = 'checkbox';
  resizeToggle.id = 'slicer-resize';
  const resizeW = numberInput('slicer-resize-w', 64, 1, 4096);
  const resizeH = numberInput('slicer-resize-h', 64, 1, 4096);
  const resizeLabel = el('label', null, 'Resize to');
  resizeLabel.htmlFor = 'slicer-resize';
  resizeRow.append(resizeToggle, resizeLabel, resizeW, el('span', null, '×'), resizeH);
  const list = el('div', 'slicer-list');
  nameSection.append(prefixRow, resizeRow, list);

  side.append(cutSection, pickSection, nameSection);

  const body = el('div', 'slicer-body');
  body.append(stage, side);

  // -- footer --
  const foot = el('div', 'slicer-foot');
  const note = el('div', 'slicer-note');
  const cancelBtn = el('button', null, 'Cancel');
  cancelBtn.type = 'button';
  const importBtn = el('button', 'slicer-primary', 'Import');
  importBtn.type = 'button';
  foot.append(note, cancelBtn, importBtn);

  dialog.append(head, body, foot);
  overlay.append(dialog);
  document.body.appendChild(overlay);

  els = {
    overlay, dialog, dims, img, plane, cellLayer, guideLayer, rulerTop, rulerLeft,
    frame, stage, colsInput, rowsInput, prefix, resizeToggle, resizeW, resizeH,
    list, note, importBtn,
  };

  // -- wiring --
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  importBtn.addEventListener('click', doImport);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });

  splitBtn.addEventListener('click', () => {
    const nc = clamp(parseInt(colsInput.value, 10) || 1, 1, MAX_GUIDES + 1);
    const nr = clamp(parseInt(rowsInput.value, 10) || 1, 1, MAX_GUIDES + 1);
    splitEvenly(nc, nr);
  });
  clearBtn.addEventListener('click', () => withGuidesChanged(() => { S.vs = []; S.hs = []; }));

  allBtn.addEventListener('click', () => { S.off.clear(); renderAll(); });
  noneBtn.addEventListener('click', () => {
    for (let r = 0; r < rows(); r++) for (let c = 0; c < cols(); c++) S.off.add(key(r, c));
    renderAll();
  });
  invertBtn.addEventListener('click', () => {
    const next = new Set();
    for (let r = 0; r < rows(); r++) {
      for (let c = 0; c < cols(); c++) if (!S.off.has(key(r, c))) next.add(key(r, c));
    }
    S.off = next;
    renderAll();
  });

  prefix.addEventListener('input', renderList);
  resizeToggle.addEventListener('change', renderFooter);
  resizeW.addEventListener('input', renderFooter);
  resizeH.addEventListener('input', renderFooter);

  rulerTop.addEventListener('pointerdown', (e) => {
    addGuide('v', (e.clientX - els.plane.getBoundingClientRect().left) / S.scale);
  });
  rulerLeft.addEventListener('pointerdown', (e) => {
    addGuide('h', (e.clientY - els.plane.getBoundingClientRect().top) / S.scale);
  });

  cellLayer.addEventListener('pointerdown', onCellPointerDown);
  guideLayer.addEventListener('pointerdown', onGuidePointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('resize', () => { if (S.open) { fit(); renderAll(); } });

  // Capture phase: while the slicer is open it owns the keyboard, so app.js's
  // window-level shortcuts (Delete, Ctrl+S, 0, F, …) stay out of the way.
  window.addEventListener('keydown', onKeyDownCapture, true);
}

// ---------------------------------------------------------------------------
// Pointer interaction
// ---------------------------------------------------------------------------

function onGuidePointerDown(e) {
  const guide = e.target.closest('.slicer-guide');
  if (!guide) return;
  e.preventDefault();
  e.stopPropagation();
  const axis = guide.dataset.axis;
  const index = Number(guide.dataset.index);
  if (e.detail >= 2) {          // double-click removes
    removeGuide(axis, index);
    return;
  }
  S.drag = { kind: 'guide', axis, index, el: guide, doomed: false };
}

function onCellPointerDown(e) {
  const cell = e.target.closest('.slicer-cell');
  if (!cell) return;
  e.preventDefault();
  const k = cell.dataset.key;
  const turningOn = S.off.has(k);
  S.drag = { kind: 'paint', turningOn };
  paintCell(k, turningOn);
}

function paintCell(k, turningOn) {
  if (turningOn) S.off.delete(k); else S.off.add(k);
  const cell = els.cellLayer.querySelector(`.slicer-cell[data-key="${CSS.escape(k)}"]`);
  if (cell) cell.classList.toggle('off', S.off.has(k));
  renderList();
  renderFooter();
}

function onPointerMove(e) {
  if (!S.drag) return;
  const rect = els.plane.getBoundingClientRect();

  if (S.drag.kind === 'guide') {
    const list = S.drag.axis === 'v' ? S.vs : S.hs;
    const raw = S.drag.axis === 'v'
      ? (e.clientX - rect.left) / S.scale
      : (e.clientY - rect.top) / S.scale;
    // Pulled well clear of the image: treat it as a discard, shown by fading
    // the guide, and commit the removal on pointerup.
    const outside = S.drag.axis === 'v'
      ? (e.clientX < rect.left - 40 || e.clientX > rect.right + 40)
      : (e.clientY < rect.top - 40 || e.clientY > rect.bottom + 40);
    S.drag.doomed = outside;
    S.drag.el.classList.toggle('doomed', outside);
    if (outside) return;

    const v = Math.round(raw);
    if (canPlace(list, v, S.drag.index)) {
      // Keep the dragged guide identifiable across the re-sort.
      const moved = v;
      withGuidesChanged(() => {
        list[S.drag.index] = moved;
        list.sort((a, b) => a - b);
      });
      S.drag.index = list.indexOf(moved);
      S.drag.el = els.guideLayer.querySelector(
        `.slicer-guide[data-axis="${S.drag.axis}"][data-index="${S.drag.index}"]`
      ) || S.drag.el;
    }
    return;
  }

  if (S.drag.kind === 'paint') {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const cell = target && target.closest ? target.closest('.slicer-cell') : null;
    if (!cell) return;
    const k = cell.dataset.key;
    if (S.off.has(k) === S.drag.turningOn) paintCell(k, S.drag.turningOn);
  }
}

function onPointerUp() {
  if (!S.drag) return;
  const drag = S.drag;
  S.drag = null;
  if (drag.kind === 'guide') {
    if (drag.doomed) removeGuide(drag.axis, drag.index);
    else drag.el.classList.remove('doomed');
    renderList(); // catch up on what the drag deferred
  }
}

function onKeyDownCapture(e) {
  if (!S.open) return;
  e.stopPropagation(); // app.js must not act on keys aimed at this dialog
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    doImport();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Fit the image inside whatever room the dialog has, never scaling above 1:1 —
// a pasted 64px sprite sheet blown up to fill the screen would just be blurry.
function fit() {
  const box = els.stage.getBoundingClientRect();
  const availW = Math.max(80, box.width - RULER - 24);
  const availH = Math.max(80, box.height - RULER - 24);
  S.scale = Math.min(1, availW / S.w, availH / S.h);
  const dw = Math.round(S.w * S.scale);
  const dh = Math.round(S.h * S.scale);
  els.plane.style.width = `${dw}px`;
  els.plane.style.height = `${dh}px`;
  els.img.style.width = `${dw}px`;
  els.img.style.height = `${dh}px`;
  els.rulerTop.style.width = `${dw}px`;
  els.rulerLeft.style.height = `${dh}px`;
}

function renderGuides() {
  els.guideLayer.innerHTML = '';
  const frag = document.createDocumentFragment();
  const add = (axis, index, value) => {
    const g = el('div', `slicer-guide slicer-guide-${axis}`);
    g.dataset.axis = axis;
    g.dataset.index = String(index);
    if (axis === 'v') g.style.left = `${value * S.scale}px`;
    else g.style.top = `${value * S.scale}px`;
    g.title = `${axis === 'v' ? 'x' : 'y'} = ${value}px — drag to move, double-click to remove`;
    frag.appendChild(g);
  };
  S.vs.forEach((v, i) => add('v', i, v));
  S.hs.forEach((v, i) => add('h', i, v));
  els.guideLayer.appendChild(frag);
}

function renderCells() {
  els.cellLayer.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let r = 0; r < rows(); r++) {
    for (let c = 0; c < cols(); c++) {
      const rect = cellRect(r, c);
      const k = key(r, c);
      const cell = el('div', 'slicer-cell');
      if (S.off.has(k)) cell.classList.add('off');
      cell.dataset.key = k;
      cell.style.left = `${rect.x * S.scale}px`;
      cell.style.top = `${rect.y * S.scale}px`;
      cell.style.width = `${rect.w * S.scale}px`;
      cell.style.height = `${rect.h * S.scale}px`;
      cell.title = `${rect.w}×${rect.h}px`;
      frag.appendChild(cell);
    }
  }
  els.cellLayer.appendChild(frag);
}

function renderList() {
  const cells = selectedCells();
  els.list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const cell of cells) {
    const row = el('div', 'slicer-list-row');
    const pos = el('span', 'slicer-list-pos', `r${cell.r + 1}c${cell.c + 1}`);
    const input = el('input', 'slicer-list-name');
    input.type = 'text';
    input.spellcheck = false;
    input.value = stemFor(cell.r, cell.c);
    input.placeholder = autoStem(cell.r, cell.c);
    input.addEventListener('input', () => {
      const k = key(cell.r, cell.c);
      // Back to the auto name when the field is emptied or matches it anyway.
      if (input.value === '' || input.value === autoStem(cell.r, cell.c)) S.names.delete(k);
      else S.names.set(k, input.value);
    });
    row.append(pos, input, el('span', 'slicer-list-ext', '.png'));
    frag.appendChild(row);
  }
  els.list.appendChild(frag);
  renderFooter();
}

function renderFooter() {
  const n = selectedCells().length;
  els.importBtn.disabled = n === 0;
  els.importBtn.textContent = n === 1 ? 'Import 1 slice' : `Import ${n} slices`;
  const size = els.resizeToggle.checked
    ? `${els.resizeW.value}×${els.resizeH.value}px each`
    : 'original size';
  els.note.textContent = n > MAX_SLICES
    ? `Too many slices (${n}, max ${MAX_SLICES}).`
    : `${rows()}×${cols()} grid · ${n} selected · ${size}`;
}

function renderAll(skipList = false) {
  renderGuides();
  renderCells();
  // The name list is one text input per slice — rebuilding it on every
  // pointermove of a guide drag is the one thing here that visibly stutters on
  // a large sheet, so defer it to the end of the gesture.
  if (skipList) renderFooter();
  else renderList();
}

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

export function openSlicer(blob) {
  if (!els) build();
  if (S.open) close();

  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    S.blobUrl = url;
    S.img = img;
    S.w = img.naturalWidth;
    S.h = img.naturalHeight;
    if (!S.w || !S.h) {
      URL.revokeObjectURL(url);
      setStatus('pasted image has no usable dimensions');
      return;
    }
    S.vs = [];
    S.hs = [];
    S.off = new Set();
    S.names = new Map();
    S.drag = null;
    S.open = true;
    setModalOpen(true);

    els.img.src = url;
    els.dims.textContent = `${S.w}×${S.h}px`;
    els.resizeW.value = String(Math.min(S.w, 64));
    els.resizeH.value = String(Math.min(S.h, 64));
    els.importBtn.disabled = false;
    els.overlay.hidden = false;
    fit();
    renderAll();
    els.prefix.focus();
    els.prefix.select();
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    setStatus('could not read the pasted image');
  };
  img.src = url;
}

export function close() {
  if (!els || !S.open) return;
  S.open = false;
  S.drag = null;
  setModalOpen(false);
  els.overlay.hidden = true;
  els.img.removeAttribute('src');
  if (S.blobUrl) {
    URL.revokeObjectURL(S.blobUrl);
    S.blobUrl = null;
  }
  S.img = null;
}

export function isOpen() {
  return S.open;
}

// Test hook: the self-test suite drives the slicer without a real clipboard.
export const _internals = { S, addGuide, removeGuide, splitEvenly, selectedCells, stemFor, doImport };
