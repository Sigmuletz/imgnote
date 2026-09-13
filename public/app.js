// imgnote — app.js
// Owns state, rendering, the palette, the toolbar, undo, keyboard shortcuts
// (everything but drag modifiers) and persistence. drag.js imports the API
// below and owns pointer-driven interaction (marquee, item drag, pan, zoom).

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const state = {
  grid: 32,
  showGrid: true,
  theme: 'dark',
  view: { x: 0, y: 0, zoom: 1 },
  items: [],
  groups: [],
  selection: new Set(),
  files: new Map(),
  dirty: false,
};

// DOM element cache, keyed by item id. Populated by render(). Each element
// also carries _w/_h (rendered size in world px) once known.
const itemEls = new Map();

let hoveredGroupId = null;
let paletteFilter = '';
// Set while a modal (the slicer) owns the keyboard. The slicer also stops
// propagation in the capture phase, but that only orders listeners correctly
// for events aimed at a focused element -- this flag holds regardless.
let modalOpen = false;

const UNDO_CAP = 100;
const undoStack = [];
let redoStack = [];

// ---------------------------------------------------------------------------
// DOM refs (queried once the document is ready)
// ---------------------------------------------------------------------------

const appEl = document.getElementById('app');
const paletteEl = document.getElementById('palette');
const paletteFilterEl = document.getElementById('palette-filter');
const paletteListEl = document.getElementById('palette-list');
const viewportEl = document.getElementById('viewport');
const gridLayerEl = document.getElementById('grid-layer');
const canvasEl = document.getElementById('canvas');
const hullLayerEl = document.getElementById('hull-layer');
const statusbarEl = document.getElementById('statusbar');

const gridSizeInput = document.getElementById('grid-size');
const showGridInput = document.getElementById('show-grid');
const themeToggleBtn = document.getElementById('theme-toggle');
const pasteImageBtn = document.getElementById('paste-image');

const alignButtons = {
  left: document.getElementById('align-left'),
  right: document.getElementById('align-right'),
  top: document.getElementById('align-top'),
  bottom: document.getElementById('align-bottom'),
  'center-x': document.getElementById('align-center-x'),
  'center-y': document.getElementById('align-center-y'),
  'distribute-x': document.getElementById('distribute-x'),
  'distribute-y': document.getElementById('distribute-y'),
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function itemSize(item) {
  const el = itemEls.get(item.id);
  return { w: el?._w ?? 64, h: el?._h ?? 64 };
}

function findItem(id) {
  return state.items.find((it) => it.id === id) || null;
}

// Drop groups that no longer have any members.
function pruneEmptyGroups() {
  const used = new Set(state.items.map((it) => it.group).filter(Boolean));
  state.groups = state.groups.filter((g) => used.has(g.id));
}

// ---------------------------------------------------------------------------
// Coordinates / snapping
// ---------------------------------------------------------------------------

export function screenToWorld(clientX, clientY) {
  const rect = viewportEl.getBoundingClientRect();
  return {
    x: (clientX - rect.left - state.view.x) / state.view.zoom,
    y: (clientY - rect.top - state.view.y) / state.view.zoom,
  };
}

export function worldToScreen(x, y) {
  const rect = viewportEl.getBoundingClientRect();
  return {
    x: x * state.view.zoom + state.view.x + rect.left,
    y: y * state.view.zoom + state.view.y + rect.top,
  };
}

export function snap(v) {
  const g = state.grid || 1;
  return Math.round(v / g) * g;
}

export function snapDelta(dx, dy) {
  return { dx: snap(dx), dy: snap(dy) };
}

// ---------------------------------------------------------------------------
// Hit testing / selection
// ---------------------------------------------------------------------------

export function itemAt(worldX, worldY) {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    const { w, h } = itemSize(item);
    if (worldX >= item.x && worldX <= item.x + w && worldY >= item.y && worldY <= item.y + h) {
      return item;
    }
  }
  return null;
}

export function itemsInRect(rect) {
  const rx2 = rect.x + rect.w;
  const ry2 = rect.y + rect.h;
  return state.items.filter((item) => {
    const { w, h } = itemSize(item);
    return item.x < rx2 && item.x + w > rect.x && item.y < ry2 && item.y + h > rect.y;
  });
}

export function expandToGroups(ids) {
  const idSet = ids instanceof Set ? ids : new Set(ids);
  const result = new Set(idSet);
  const groupIds = new Set();
  for (const id of idSet) {
    const item = findItem(id);
    if (item && item.group) groupIds.add(item.group);
  }
  if (groupIds.size) {
    for (const item of state.items) {
      if (item.group && groupIds.has(item.group)) result.add(item.id);
    }
  }
  return result;
}

export function setSelection(ids) {
  state.selection = expandToGroups(ids);
  renderTransforms();
  renderHulls();
  updateToolbarState();
}

export function selectedItems() {
  return state.items.filter((it) => state.selection.has(it.id));
}

export function setHoveredGroup(groupId) {
  if (hoveredGroupId === groupId) return;
  hoveredGroupId = groupId;
  renderHulls();
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

function snapshot() {
  return structuredClone({ items: state.items, groups: state.groups, grid: state.grid });
}

export function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > UNDO_CAP) undoStack.shift();
  redoStack = [];
}

function restore(snap) {
  state.items = snap.items;
  state.groups = snap.groups;
  state.grid = snap.grid;
  state.selection = new Set();
  syncGridInputFromState();
  markDirty();
  render();
}

/**
 * Abort the most recent mutation: restore the snapshot it pushed and discard
 * that history entry, so a cancelled gesture costs nothing on the undo stack.
 * Leaves the dirty flag as it was before the aborted mutation.
 */
export function rollback() {
  if (!undoStack.length) return;
  const wasDirty = state.dirty;
  restore(undoStack.pop());
  redoStack = [];
  state.dirty = wasDirty;
  updateStatusBar();
}

function undo() {
  if (!undoStack.length) return;
  const current = snapshot();
  const prev = undoStack.pop();
  redoStack.push(current);
  restore(prev);
}

function redo() {
  if (!redoStack.length) return;
  const current = snapshot();
  const next = redoStack.pop();
  undoStack.push(current);
  restore(next);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function addInstance(src, x, y) {
  pushUndo();
  const item = { id: uid(), src, x, y, group: null };
  state.items.push(item);
  markDirty();
  render();
  return item;
}

export function duplicateSelection(dx, dy) {
  const items = selectedItems();
  if (!items.length) return [];
  pushUndo();

  const groupMap = new Map(); // old group id -> new group id
  const copies = items.map((item) => {
    let group = null;
    if (item.group) {
      if (!groupMap.has(item.group)) {
        const gid = uid();
        groupMap.set(item.group, gid);
        state.groups.push({ id: gid });
      }
      group = groupMap.get(item.group);
    }
    return { id: uid(), src: item.src, x: item.x + dx, y: item.y + dy, group };
  });

  state.items.push(...copies);
  markDirty();
  setSelection(copies.map((c) => c.id));
  render();
  return copies;
}

export function removeSelection() {
  if (!state.selection.size) return;
  pushUndo();
  const toRemove = state.selection;
  state.items = state.items.filter((it) => !toRemove.has(it.id));
  pruneEmptyGroups();
  state.selection = new Set();
  markDirty();
  render();
}

function groupSelection() {
  const items = selectedItems();
  if (items.length < 2) return;
  pushUndo();
  const gid = uid();
  state.groups.push({ id: gid });
  for (const item of items) item.group = gid;
  markDirty();
  renderHulls();
}

function ungroupSelection() {
  const items = selectedItems();
  if (!items.some((it) => it.group)) return;
  pushUndo();
  for (const item of items) item.group = null;
  pruneEmptyGroups();
  markDirty();
  renderHulls();
}

// ---------------------------------------------------------------------------
// Align / distribute
// ---------------------------------------------------------------------------

function alignSelection(mode) {
  const items = selectedItems();
  if (items.length < 2) return;
  pushUndo();

  const boxes = items.map((item) => ({ item, ...itemSize(item) }));
  const minX = Math.min(...boxes.map((b) => b.item.x));
  const maxX = Math.max(...boxes.map((b) => b.item.x + b.w));
  const minY = Math.min(...boxes.map((b) => b.item.y));
  const maxY = Math.max(...boxes.map((b) => b.item.y + b.h));

  switch (mode) {
    case 'left':
      boxes.forEach((b) => { b.item.x = minX; });
      break;
    case 'right':
      boxes.forEach((b) => { b.item.x = maxX - b.w; });
      break;
    case 'top':
      boxes.forEach((b) => { b.item.y = minY; });
      break;
    case 'bottom':
      boxes.forEach((b) => { b.item.y = maxY - b.h; });
      break;
    case 'center-x': {
      const c = (minX + maxX) / 2;
      boxes.forEach((b) => { b.item.x = c - b.w / 2; });
      break;
    }
    case 'center-y': {
      const c = (minY + maxY) / 2;
      boxes.forEach((b) => { b.item.y = c - b.h / 2; });
      break;
    }
    case 'distribute-x': {
      const sorted = [...boxes].sort((a, b) => (a.item.x + a.w / 2) - (b.item.x + b.w / 2));
      const first = sorted[0].item.x + sorted[0].w / 2;
      const last = sorted[sorted.length - 1].item.x + sorted[sorted.length - 1].w / 2;
      const step = (last - first) / (sorted.length - 1);
      sorted.forEach((b, i) => { b.item.x = (first + step * i) - b.w / 2; });
      break;
    }
    case 'distribute-y': {
      const sorted = [...boxes].sort((a, b) => (a.item.y + a.h / 2) - (b.item.y + b.h / 2));
      const first = sorted[0].item.y + sorted[0].h / 2;
      const last = sorted[sorted.length - 1].item.y + sorted[sorted.length - 1].h / 2;
      const step = (last - first) / (sorted.length - 1);
      sorted.forEach((b, i) => { b.item.y = (first + step * i) - b.h / 2; });
      break;
    }
    default:
      return;
  }

  // Align/distribute results re-snap to the grid.
  for (const item of items) {
    item.x = snap(item.x);
    item.y = snap(item.y);
  }

  markDirty();
  renderTransforms();
  renderHulls();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function render() {
  renderPalette();
  renderItems();
  renderTransforms();
  applyView();
  renderHulls();
  updateToolbarState();
  updateStatusBar();
}

function renderItems() {
  itemEls.clear();
  const frag = document.createDocumentFragment();

  for (const item of state.items) {
    const el = document.createElement('div');
    el.className = 'item';
    el.dataset.id = item.id;

    const fileInfo = state.files.get(item.src);
    if (!fileInfo) {
      el.classList.add('missing');
      el._w = 64;
      el._h = 64;
      const label = document.createElement('span');
      label.className = 'missing-name';
      label.textContent = item.src;
      el.appendChild(label);
    } else {
      el._w = 64; // fallback until the image reports its own size
      el._h = 64;
      const img = document.createElement('img');
      img.draggable = false;
      img.alt = item.src;
      img.addEventListener('load', () => {
        el._w = img.naturalWidth || 64;
        el._h = img.naturalHeight || 64;
        renderHulls();
      });
      img.src = `/img/${encodeURIComponent(item.src)}`;
      el.appendChild(img);
    }

    itemEls.set(item.id, el);
    frag.appendChild(el);
  }

  for (const child of Array.from(canvasEl.querySelectorAll(':scope > .item'))) {
    child.remove();
  }
  canvasEl.insertBefore(frag, hullLayerEl);
}

export function renderTransforms() {
  for (const item of state.items) {
    const el = itemEls.get(item.id);
    if (!el) continue;
    el.style.transform = `translate(${item.x}px, ${item.y}px)`;
    el.classList.toggle('selected', state.selection.has(item.id));
  }
}

export function applyView() {
  const { x, y, zoom } = state.view;
  canvasEl.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;

  const size = state.grid * zoom;
  gridLayerEl.style.backgroundSize = `${size}px ${size}px`;
  gridLayerEl.style.backgroundPosition = `${x}px ${y}px`;
  gridLayerEl.style.visibility = state.showGrid ? 'visible' : 'hidden';
}

export function renderHulls() {
  hullLayerEl.innerHTML = '';

  const groupIds = new Set();
  if (hoveredGroupId) groupIds.add(hoveredGroupId);
  for (const item of selectedItems()) {
    if (item.group) groupIds.add(item.group);
  }
  if (!groupIds.size) return;

  const PAD = 8;
  for (const gid of groupIds) {
    const members = state.items.filter((it) => it.group === gid);
    if (!members.length) continue;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const item of members) {
      const { w, h } = itemSize(item);
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + w);
      maxY = Math.max(maxY, item.y + h);
    }

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', 'hull');
    rect.setAttribute('x', minX - PAD);
    rect.setAttribute('y', minY - PAD);
    rect.setAttribute('width', maxX - minX + PAD * 2);
    rect.setAttribute('height', maxY - minY + PAD * 2);
    hullLayerEl.appendChild(rect);
  }
}

function renderPalette() {
  paletteListEl.innerHTML = '';
  const filter = paletteFilter.trim().toLowerCase();
  const names = [...state.files.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  for (const name of names) {
    if (filter && !name.toLowerCase().includes(filter)) continue;

    const el = document.createElement('div');
    el.className = 'palette-item';
    el.dataset.src = name;
    el.draggable = false;

    const img = document.createElement('img');
    img.src = `/img/${encodeURIComponent(name)}`;
    img.alt = name;
    img.draggable = false;

    const label = document.createElement('span');
    label.className = 'palette-name';
    label.textContent = name;

    el.appendChild(img);
    el.appendChild(label);
    paletteListEl.appendChild(el);
  }
}

function updateToolbarState() {
  const enabled = state.selection.size >= 2;
  for (const btn of Object.values(alignButtons)) {
    if (btn) btn.disabled = !enabled;
  }
}

function updateStatusBar() {
  if (!statusbarEl) return;
  const count = state.items.length;
  const sel = state.selection.size;
  const dirtyText = state.dirty ? 'unsaved changes' : 'saved';
  statusbarEl.textContent =
    `${count} item${count === 1 ? '' : 's'} · ${sel} selected · grid ${state.grid}px · ${dirtyText}`;
}

export function markDirty() {
  state.dirty = true;
  updateStatusBar();
}

// One-off message in the status bar. The next render() replaces it with the
// usual item/selection tally, which is what we want for transient notices.
export function setStatus(text) {
  if (statusbarEl) statusbarEl.textContent = text;
}

// Re-read the folder listing after files appear on disk (an import), so the
// palette picks them up without a page reload.
export async function refreshFiles() {
  const res = await fetch('/files');
  const data = await res.json();
  state.files = new Map((data.files || []).map((f) => [f.name, f]));
  render();
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function applyTheme() {
  if (state.theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  if (themeToggleBtn) themeToggleBtn.textContent = state.theme === 'dark' ? 'Light' : 'Dark';
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  markDirty();
}

// ---------------------------------------------------------------------------
// Palette collapse
// ---------------------------------------------------------------------------

function togglePalette() {
  appEl.classList.toggle('palette-collapsed');
}

// ---------------------------------------------------------------------------
// Navigation helpers (0 / F)
// ---------------------------------------------------------------------------

function resetZoom() {
  const rect = viewportEl.getBoundingClientRect();
  const centerScreen = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const worldCenter = screenToWorld(centerScreen.x, centerScreen.y);
  state.view.zoom = 1;
  state.view.x = rect.width / 2 - worldCenter.x;
  state.view.y = rect.height / 2 - worldCenter.y;
  applyView();
}

function fitAll() {
  const rect = viewportEl.getBoundingClientRect();
  if (!state.items.length) {
    state.view = { x: 0, y: 0, zoom: 1 };
    applyView();
    return;
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of state.items) {
    const { w, h } = itemSize(item);
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + w);
    maxY = Math.max(maxY, item.y + h);
  }

  const pad = 48;
  const boxW = Math.max(1, maxX - minX);
  const boxH = Math.max(1, maxY - minY);
  const availW = Math.max(1, rect.width - pad * 2);
  const availH = Math.max(1, rect.height - pad * 2);

  let zoom = Math.min(availW / boxW, availH / boxH);
  zoom = Math.max(0.25, Math.min(4, zoom || 1));

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  state.view.zoom = zoom;
  state.view.x = rect.width / 2 - cx * zoom;
  state.view.y = rect.height / 2 - cy * zoom;
  applyView();
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

async function save() {
  const payload = {
    version: 1,
    grid: state.grid,
    showGrid: state.showGrid,
    theme: state.theme,
    view: state.view,
    items: state.items.map(({ id, src, x, y, group }) => ({ id, src, x, y, group })),
    groups: state.groups.map(({ id }) => ({ id })),
  };

  try {
    const res = await fetch('/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({ ok: false, error: 'bad response' }));
    if (res.ok && data.ok) {
      state.dirty = false;
      updateStatusBar();
    } else {
      statusbarEl.textContent = `save failed: ${data.error || res.status}`;
    }
  } catch (err) {
    statusbarEl.textContent = `save failed: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Clipboard import
// ---------------------------------------------------------------------------

// The slicer is loaded on first use: a session that never pastes an image
// never pays for it.
// Called by slice.js while its dialog is up, so board shortcuts stand down.
export function setModalOpen(open) {
  modalOpen = !!open;
}

async function openSlicer(blob) {
  try {
    const mod = await import('./slice.js');
    mod.openSlicer(blob);
  } catch (err) {
    setStatus(`could not open the slicer: ${err.message}`);
  }
}

function imageFromTransfer(dt) {
  if (!dt) return null;
  for (const item of dt.items || []) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  for (const file of dt.files || []) {
    if (file.type.startsWith('image/')) return file;
  }
  return null;
}

function onPaste(e) {
  const blob = imageFromTransfer(e.clipboardData);
  if (!blob) return; // plain text paste into the filter box etc. — leave it alone
  e.preventDefault();
  openSlicer(blob);
}

// Toolbar affordance for the same thing. The async clipboard API needs a
// permission the user may not grant; Ctrl+V always works, so say so.
async function pasteFromToolbar() {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    setStatus('clipboard button unavailable — press Ctrl+V to paste an image');
    return;
  }
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) {
        openSlicer(await item.getType(type));
        return;
      }
    }
    setStatus('no image on the clipboard');
  } catch {
    setStatus('clipboard read blocked by the browser — press Ctrl+V instead');
  }
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts (everything except drag modifiers, which drag.js owns)
// ---------------------------------------------------------------------------

function isTextInput(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

function onKeyDown(e) {
  if (modalOpen) return;             // the slicer dialog has the keyboard
  if (isTextInput(e.target)) return; // includes the palette filter

  const mod = e.ctrlKey || e.metaKey;
  const key = e.key;

  if (mod && key.toLowerCase() === 'g' && e.shiftKey) {
    e.preventDefault();
    ungroupSelection();
    return;
  }
  if (mod && key.toLowerCase() === 'g') {
    e.preventDefault();
    groupSelection();
    return;
  }
  if (mod && key.toLowerCase() === 'd') {
    e.preventDefault();
    duplicateSelection(state.grid, 0);
    return;
  }
  if (mod && key.toLowerCase() === 'a') {
    e.preventDefault();
    setSelection(state.items.map((it) => it.id));
    return;
  }
  if (mod && key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (mod && key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
    return;
  }
  if (mod && key.toLowerCase() === 's') {
    e.preventDefault();
    save();
    return;
  }
  if (!mod && (key === 'Delete' || key === 'Backspace')) {
    e.preventDefault();
    removeSelection();
    return;
  }
  if (!mod && key === 'Escape') {
    setSelection([]);
    return;
  }
  if (!mod && key === '0') {
    resetZoom();
    return;
  }
  if (!mod && key.toLowerCase() === 'f') {
    fitAll();
    return;
  }
  if (!mod && key === '\\') {
    togglePalette();
    return;
  }
}

// ---------------------------------------------------------------------------
// Toolbar wiring
// ---------------------------------------------------------------------------

function syncGridInputFromState() {
  if (gridSizeInput) gridSizeInput.value = String(state.grid);
  applyView();
}

function initToolbar() {
  if (gridSizeInput) {
    gridSizeInput.value = String(state.grid);
    // Live preview of the dot spacing while typing; the change only becomes
    // a real (undoable) mutation once the value commits.
    gridSizeInput.addEventListener('input', () => {
      const val = parseInt(gridSizeInput.value, 10);
      if (Number.isFinite(val) && val > 0) {
        const size = val * state.view.zoom;
        gridLayerEl.style.backgroundSize = `${size}px ${size}px`;
      }
    });
    gridSizeInput.addEventListener('change', () => {
      const val = parseInt(gridSizeInput.value, 10);
      if (Number.isFinite(val) && val > 0 && val !== state.grid) {
        pushUndo();
        state.grid = val; // does not re-snap existing items
        markDirty();
      }
      applyView();
    });
  }

  if (showGridInput) {
    showGridInput.checked = state.showGrid;
    showGridInput.addEventListener('change', () => {
      state.showGrid = showGridInput.checked;
      markDirty();
      applyView();
    });
  }

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', toggleTheme);
  }

  if (pasteImageBtn) {
    pasteImageBtn.addEventListener('click', pasteFromToolbar);
  }

  for (const [mode, btn] of Object.entries(alignButtons)) {
    if (btn) btn.addEventListener('click', () => alignSelection(mode));
  }

  if (paletteFilterEl) {
    paletteFilterEl.addEventListener('input', () => {
      paletteFilter = paletteFilterEl.value;
      renderPalette();
    });
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function applyLayout(layout) {
  if (!layout) return;
  state.grid = layout.grid ?? state.grid;
  state.showGrid = layout.showGrid ?? state.showGrid;
  state.theme = layout.theme ?? state.theme;
  state.view = layout.view ?? state.view;
  state.items = Array.isArray(layout.items) ? layout.items : [];
  state.groups = Array.isArray(layout.groups) ? layout.groups : [];
}

async function boot() {
  initToolbar();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('paste', onPaste);
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  try {
    const res = await fetch('/files');
    const data = await res.json();
    state.files = new Map((data.files || []).map((f) => [f.name, f]));
    applyLayout(data.layout);
  } catch (err) {
    // No server data available; fall back to the built-in defaults so the
    // app is still usable (and app.js's API still works for drag.js).
    console.error('imgnote: failed to load /files', err);
  }

  applyTheme();
  syncGridInputFromState();
  if (showGridInput) showGridInput.checked = state.showGrid;
  render();

  try {
    const { initInteractions } = await import('./drag.js');
    initInteractions();
  } catch (err) {
    console.warn('imgnote: drag.js not available yet', err);
  }
}

boot();
