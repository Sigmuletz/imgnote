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
  // Frames are dashed boxes drawn under every item. They own no members:
  // what a frame carries is whatever geometry says it contains at the moment
  // it is dragged (see itemsInFrame).
  frames: [],
  // Connectors between two items, stored as a pair of item ids plus the ids of
  // the rules they answer to. The geometry is derived from wherever those items
  // are, so a line never needs updating.
  lines: [],
  // Named offset constraints, shared: one rule can govern any number of lines,
  // which is the point -- "these two always sit a cell apart" is one fact.
  rules: [],
  selection: new Set(),
  frameSelection: new Set(),
  lineSelection: new Set(),
  files: new Map(),
  dirty: false,
};

// DOM element cache, keyed by item id. Populated by render(). Each element
// also carries _w/_h (rendered size in world px) once known.
const itemEls = new Map();
const frameEls = new Map();
const lineEls = new Map();
// Rows in the rules panel, keyed by rule id, so the live readout can refresh
// their pass/fail marks without rebuilding (and unfocusing) the fields.
const ruleRowEls = new Map();
let previewLineEl = null;

// Line-tool state. Transient: never saved, never undoable.
let lineMode = false;
let pendingLineFrom = null;   // item id of the first click, or null
let linePreviewPoint = null;  // world coords of the cursor while half-drawn

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
let frameLayerEl = document.getElementById('frame-layer');
let lineLayerEl = document.getElementById('line-layer');
const hullLayerEl = document.getElementById('hull-layer');
const statusbarEl = document.getElementById('statusbar');

const rulesPanelEl = document.getElementById('rules-panel');
const rulesTitleEl = document.getElementById('rules-title');
const rulesEndsEl = document.getElementById('rules-ends');
const rulesDxEl = document.getElementById('rules-dx');
const rulesDyEl = document.getElementById('rules-dy');
const rulesListEl = document.getElementById('rules-list');
const rulesAttachEl = document.getElementById('rules-attach');
const rulesNewBtn = document.getElementById('rules-new');
const rulesSwapBtn = document.getElementById('rules-swap');

const gridSizeInput = document.getElementById('grid-size');
const showGridInput = document.getElementById('show-grid');
const themeToggleBtn = document.getElementById('theme-toggle');
const pasteImageBtn = document.getElementById('paste-image');
const addFrameBtn = document.getElementById('add-frame');
const lineToolBtn = document.getElementById('line-tool');

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

/**
 * Build the frame and line layers if the page shell does not carry them.
 * Without this a shell that predates a layer silently swallows everything
 * drawn into it -- lines pile up in the state with nowhere to appear.
 */
function ensureLayers() {
  if (!canvasEl) return;
  // isConnected, not just null: a cached reference to a layer that has been
  // taken out of the document is exactly as useless as never having one.
  if (!frameLayerEl || !frameLayerEl.isConnected) {
    frameLayerEl = document.createElement('div');
    frameLayerEl.id = 'frame-layer';
    canvasEl.insertBefore(frameLayerEl, canvasEl.firstChild);
  }
  if (!lineLayerEl || !lineLayerEl.isConnected) {
    lineLayerEl = document.createElementNS(SVG_NS, 'svg');
    lineLayerEl.id = 'line-layer';
    // Matches the shell: a viewport big enough to paint into, mapped 1:1 onto
    // world coordinates. Without it the layer is 0x0 and draws nothing.
    lineLayerEl.setAttribute('viewBox', '-50000 -50000 100000 100000');
    lineLayerEl.setAttribute('preserveAspectRatio', 'none');
    frameLayerEl.after(lineLayerEl);
  }
  ensureLineMarkers();
}

// Arrowhead ids, referenced from marker-end on a constrained line.
const ARROW_OK_ID = 'line-arrow';
const ARROW_BROKEN_ID = 'line-arrow-broken';

/**
 * The <defs> holding the two arrowheads. Built here rather than in the page
 * shell for the same reason the layer is: a shell that predates them would
 * leave every constrained line pointing at a marker that does not exist, which
 * paints nothing and reports nothing. renderLines() empties the layer, so this
 * runs again from there too.
 */
function ensureLineMarkers() {
  if (!lineLayerEl || lineLayerEl.querySelector('defs')) return;
  const defs = document.createElementNS(SVG_NS, 'defs');
  for (const [id, cls] of [[ARROW_OK_ID, 'line-arrow-ok'], [ARROW_BROKEN_ID, 'line-arrow-broken']]) {
    const marker = document.createElementNS(SVG_NS, 'marker');
    marker.setAttribute('id', id);
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '10');   // tip lands on the line's end point
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '5');
    marker.setAttribute('markerHeight', '5');
    marker.setAttribute('markerUnits', 'strokeWidth');
    marker.setAttribute('orient', 'auto'); // along the segment, so it reads a -> b
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', cls);
    path.setAttribute('d', 'M0,0 L10,5 L0,10 Z');
    marker.appendChild(path);
    defs.appendChild(marker);
  }
  lineLayerEl.insertBefore(defs, lineLayerEl.firstChild);
}

function itemCenter(item) {
  const { w, h } = itemSize(item);
  return { x: item.x + w / 2, y: item.y + h / 2 };
}

/**
 * True when a connector is completely covered by the two icons it joins.
 * Lines are drawn behind the icons, so two icons sitting close together leave
 * the whole segment buried -- worth saying out loud rather than looking broken.
 *
 * The segment starts at one centre and ends at the other, so it is hidden when
 * the part inside the first box already reaches the part inside the second.
 */
export function lineIsHidden(line) {
  const a = findItem(line.a);
  const b = findItem(line.b);
  if (!a || !b) return true;

  const sa = itemSize(a);
  const sb = itemSize(b);
  const dx = (b.x + sb.w / 2) - (a.x + sa.w / 2);
  const dy = (b.y + sb.h / 2) - (a.y + sa.h / 2);
  if (dx === 0 && dy === 0) return true;

  // How far along the segment each box extends, as a fraction of its length.
  const reach = (size) => Math.min(
    dx ? (size.w / 2) / Math.abs(dx) : Infinity,
    dy ? (size.h / 2) / Math.abs(dy) : Infinity,
  );
  return reach(sa) + reach(sb) >= 1;
}

export function findLine(id) {
  return state.lines.find((l) => l.id === id) || null;
}

// A line whose endpoints are not both on the board any more is meaningless.
function pruneDanglingLines() {
  const ids = new Set(state.items.map((it) => it.id));
  state.lines = state.lines.filter((l) => ids.has(l.a) && ids.has(l.b));
}

function lineExists(a, b) {
  return state.lines.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
}

// ---------------------------------------------------------------------------
// Line rules
//
// A rule is a named box the offset between two icon centres has to land in:
// dx = centre(b) - centre(a), dy likewise, both raw world px. +dx means b is
// right of a, +dy means b is below a -- no negation anywhere, so what the
// panel says matches what the board looks like. An axis set to null is not
// constrained at all; a null bound is that side's infinity.
// ---------------------------------------------------------------------------

export function findRule(id) {
  return state.rules.find((r) => r.id === id) || null;
}

export function addRule(rule) {
  state.rules.push(rule);
  return rule;
}

/**
 * Drop a rule from the library and from every line that carried it. Stripping
 * the ids matters: a leftover id is dead weight that would spring back to life
 * the day uid() handed the same string to a new rule.
 */
export function removeRule(id) {
  state.rules = state.rules.filter((r) => r.id !== id);
  for (const line of state.lines) {
    if (line.rules?.includes(id)) line.rules = line.rules.filter((rid) => rid !== id);
  }
}

export function attachRule(lineId, ruleId) {
  const line = findLine(lineId);
  if (!line || !findRule(ruleId)) return;
  if (!line.rules) line.rules = [];
  if (!line.rules.includes(ruleId)) line.rules.push(ruleId);
}

export function detachRule(lineId, ruleId) {
  const line = findLine(lineId);
  if (!line || !line.rules) return;
  line.rules = line.rules.filter((rid) => rid !== ruleId);
}

// null is "this rule says nothing about this axis", not "fails".
function axisHolds(range, d) {
  if (!range) return null;
  const min = range.min ?? -Infinity;
  const max = range.max ?? Infinity;
  return d >= min && d <= max;
}

/**
 * Measure a line against its rules. Rules combine with AND: one broken rule
 * breaks the line. An id with no rule behind it is skipped rather than failed,
 * so deleting a rule relaxes the lines it governed instead of breaking them.
 *
 * A rule with `invert` set passes exactly when it would otherwise fail, which
 * is how "keep these two apart" is written: the same ranges, read as forbidden
 * ground rather than required ground.
 */
export function evaluateLine(line) {
  const a = line && findItem(line.a);
  const b = line && findItem(line.b);
  if (!a || !b) return { dx: 0, dy: 0, constrained: false, ok: true, results: [] };

  const ca = itemCenter(a);
  const cb = itemCenter(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;

  const results = [];
  let ok = true;
  for (const id of line.rules || []) {
    const rule = findRule(id);
    if (!rule) continue;
    const x = axisHolds(rule.x, dx);
    const y = axisHolds(rule.y, dy);
    // `invert` turns the rule into its opposite: the offset now has to land
    // OUTSIDE the ranges. The axis results stay raw, so the panel can still
    // point at whichever axis decided the outcome either way.
    const holds = x !== false && y !== false;
    const ruleOk = rule.invert ? !holds : holds;
    if (!ruleOk) ok = false;
    results.push({ rule, ok: ruleOk, x, y });
  }
  return { dx, dy, constrained: results.length > 0, ok, results };
}

// Which end is the origin is the whole meaning of a signed rule, so it needs
// to be one keystroke to flip. Callers own the undo snapshot and the repaint.
export function swapLineEnds(ids) {
  for (const id of ids) {
    const line = findLine(id);
    if (!line) continue;
    const a = line.a;
    line.a = line.b;
    line.b = a;
  }
}

export function brokenLineCount() {
  let n = 0;
  for (const line of state.lines) {
    const ev = evaluateLine(line);
    if (ev.constrained && !ev.ok) n++;
  }
  return n;
}

export function findFrame(id) {
  return state.frames.find((f) => f.id === id) || null;
}

export function selectedFrames() {
  return state.frames.filter((f) => state.frameSelection.has(f.id));
}

// A frame carries an item when the item's centre falls inside it. Centre
// rather than overlap, so an icon straddling an edge belongs to exactly one
// side and two touching frames never fight over it.
export function itemsInFrame(frame) {
  return state.items.filter((item) => {
    const { w, h } = itemSize(item);
    const cx = item.x + w / 2;
    const cy = item.y + h / 2;
    return cx >= frame.x && cx <= frame.x + frame.w && cy >= frame.y && cy <= frame.y + frame.h;
  });
}

/**
 * Every item id the given frames carry, expanded to whole groups: a group
 * that is only partly inside a frame still travels intact, because splitting
 * one would silently change offsets that are supposed to be atomic.
 */
export function frameContentIds(frameIds) {
  const ids = new Set();
  for (const fid of frameIds) {
    const frame = findFrame(fid);
    if (!frame) continue;
    for (const item of itemsInFrame(frame)) ids.add(item.id);
  }
  return expandToGroups(ids);
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

/**
 * The item the line tool should act on for a point. Falls back to the nearest
 * item within `tolerance` world px of its box, so a click that lands a few
 * pixels off a small icon still connects instead of doing nothing.
 */
export function lineTargetAt(worldX, worldY, tolerance = 0) {
  const direct = itemAt(worldX, worldY);
  if (direct) return direct;
  if (tolerance <= 0) return null;

  let best = null;
  let bestDist = Infinity;
  for (const item of state.items) {
    const { w, h } = itemSize(item);
    const dx = Math.max(item.x - worldX, 0, worldX - (item.x + w));
    const dy = Math.max(item.y - worldY, 0, worldY - (item.y + h));
    const dist = Math.hypot(dx, dy);
    if (dist <= tolerance && dist < bestDist) {
      bestDist = dist;
      best = item;
    }
  }
  return best;
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

// Items and frames are two selections that never hold at once: picking one
// kind clears the other, so Delete and the arrange buttons are never ambiguous.
export function setSelection(ids) {
  state.selection = expandToGroups(ids);
  state.frameSelection = new Set();
  state.lineSelection = new Set();
  renderTransforms();
  renderHulls();
  renderRulesPanel();
  updateToolbarState();
}

export function setFrameSelection(ids) {
  state.frameSelection = new Set(ids);
  state.selection = new Set();
  state.lineSelection = new Set();
  renderTransforms();
  renderHulls();
  renderRulesPanel();
  updateToolbarState();
}

export function setLineSelection(ids) {
  state.lineSelection = new Set(ids);
  state.selection = new Set();
  state.frameSelection = new Set();
  renderTransforms();
  renderHulls();
  renderRulesPanel();
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

// structuredClone, not a shallow copy: a line's `rules` array and a rule's
// x/y ranges are nested, and an undo that shared them would "restore" the
// edit it was meant to take back.
function snapshot() {
  return structuredClone({
    items: state.items,
    groups: state.groups,
    frames: state.frames,
    lines: state.lines,
    rules: state.rules,
    grid: state.grid,
  });
}

export function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > UNDO_CAP) undoStack.shift();
  redoStack = [];
}

function restore(snap) {
  state.items = snap.items;
  state.groups = snap.groups;
  state.frames = snap.frames ?? [];
  state.lines = snap.lines ?? [];
  state.rules = snap.rules ?? [];
  state.grid = snap.grid;
  state.selection = new Set();
  state.frameSelection = new Set();
  state.lineSelection = new Set();
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

/**
 * Drop the most recent snapshot without restoring it: for a gesture that
 * pushed one and then turned out to change nothing. Unlike rollback() this
 * leaves the live state (and the selection) exactly as it is.
 */
export function discardUndo() {
  undoStack.pop();
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
  const idMap = new Map();    // old item id -> new item id
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
    const id = uid();
    idMap.set(item.id, id);
    return { id, src: item.src, x: item.x + dx, y: item.y + dy, group };
  });

  state.items.push(...copies);

  // A line is copied only when both of its ends were copied: the pair of
  // duplicates comes out connected the same way, and a line reaching outside
  // the selection is left alone rather than re-pointed at a copy.
  //
  // The copies come out bare. A duplicate is a place to try a different
  // arrangement, and inheriting the original's rules would paint it broken
  // the moment it was moved, which is exactly what it is for.
  for (const line of state.lines.slice()) {
    if (idMap.has(line.a) && idMap.has(line.b)) {
      state.lines.push({ id: uid(), a: idMap.get(line.a), b: idMap.get(line.b), rules: [] });
    }
  }
  markDirty();
  setSelection(copies.map((c) => c.id));
  render();
  return copies;
}

export function removeSelection() {
  if (!state.selection.size && !state.frameSelection.size && !state.lineSelection.size) return;
  pushUndo();
  if (state.selection.size) {
    const toRemove = state.selection;
    state.items = state.items.filter((it) => !toRemove.has(it.id));
    pruneEmptyGroups();
    pruneDanglingLines(); // a line to an item that is gone goes with it
  }
  if (state.lineSelection.size) {
    const toRemove = state.lineSelection;
    state.lines = state.lines.filter((l) => !toRemove.has(l.id));
  }
  if (state.frameSelection.size) {
    // Deleting a frame deletes the box, never what stood inside it.
    const toRemove = state.frameSelection;
    state.frames = state.frames.filter((f) => !toRemove.has(f.id));
  }
  state.selection = new Set();
  state.frameSelection = new Set();
  state.lineSelection = new Set();
  markDirty();
  render();
}

// Smallest frame a resize will produce, in world px.
export const FRAME_MIN = 32;

const FRAME_DEFAULT_TITLE = 'Frame';

/**
 * Add a frame: wrapped around the current selection when there is one,
 * otherwise a default-sized box in the middle of the view.
 */
export function addFrame() {
  const PAD = 24;
  const sel = selectedItems();
  let rect;

  if (sel.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const item of sel) {
      const { w, h } = itemSize(item);
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + w);
      maxY = Math.max(maxY, item.y + h);
    }
    const x = snap(minX - PAD);
    const y = snap(minY - PAD);
    rect = { x, y, w: snap(maxX + PAD) - x, h: snap(maxY + PAD) - y };
  } else {
    const vp = viewportEl.getBoundingClientRect();
    const c = screenToWorld(vp.left + vp.width / 2, vp.top + vp.height / 2);
    rect = { x: snap(c.x - 160), y: snap(c.y - 120), w: 320, h: 240 };
  }

  pushUndo();
  const frame = {
    id: uid(),
    x: rect.x,
    y: rect.y,
    w: Math.max(FRAME_MIN, rect.w),
    h: Math.max(FRAME_MIN, rect.h),
    title: FRAME_DEFAULT_TITLE,
  };
  state.frames.push(frame);
  markDirty();
  setFrameSelection([frame.id]);
  render();
  return frame;
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
// Line tool
// ---------------------------------------------------------------------------

export function isLineMode() {
  return lineMode;
}

export function pendingLineAnchor() {
  return pendingLineFrom;
}

export function toggleLineMode(force) {
  lineMode = force === undefined ? !lineMode : !!force;
  pendingLineFrom = null;
  linePreviewPoint = null;
  viewportEl?.classList.toggle('line-mode', lineMode);
  lineToolBtn?.classList.toggle('active', lineMode);
  if (lineMode) setSelection([]); // the tool draws, it does not select
  renderTransforms();
  updateStatusBar();
}

export function cancelPendingLine() {
  if (!pendingLineFrom) return;
  pendingLineFrom = null;
  linePreviewPoint = null;
  renderTransforms();
  updateStatusBar();
}

export function updateLinePreview(worldX, worldY) {
  if (!lineMode || !pendingLineFrom) return;
  linePreviewPoint = { x: worldX, y: worldY };
  renderLinePreview();
}

/**
 * One click of the two-click line gesture. The first click arms an anchor,
 * the second connects to it. Clicking the anchor again cancels, and a pair
 * that is already connected is refused rather than doubled.
 */
export function lineClickItem(itemId) {
  if (!lineMode || !findItem(itemId)) return;

  if (!pendingLineFrom) {
    pendingLineFrom = itemId;
    linePreviewPoint = null;
    renderTransforms();
    setStatus('line: click a second icon, or drag onto one (Esc cancels)');
    return;
  }

  if (pendingLineFrom === itemId) {
    cancelPendingLine();
    setStatus('line: cancelled');
    return;
  }

  const from = pendingLineFrom;
  pendingLineFrom = null;
  linePreviewPoint = null;

  const existing = state.lines.find(
    (l) => (l.a === from && l.b === itemId) || (l.a === itemId && l.b === from),
  );
  if (existing) {
    // Select the line that is already there, so "already connected" points at
    // something the user can see and delete instead of just refusing.
    setLineSelection([existing.id]);
    setStatus(lineIsHidden(existing)
      ? 'line: already connected — that line is hidden behind the two icons'
      : 'line: those two are already connected');
    return;
  }

  pushUndo();
  const line = { id: uid(), a: from, b: itemId, rules: [] };
  state.lines.push(line);
  markDirty();
  render();
  setStatus(lineIsHidden(line)
    ? 'line added — hidden behind the icons; move them apart to see it'
    : 'line: click an icon to start another (Esc leaves the tool)');
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
  ensureLayers();
  renderPalette();
  renderFrames();
  renderLines();
  renderItems();
  renderTransforms();
  applyView();
  renderHulls();
  renderRulesPanel();
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
        renderLineTransforms(); // the centre moved, so its connectors did too
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

// Frames live in their own layer, which sits before the items in #canvas --
// that is the whole of "always drawn below the icons".
function renderFrames() {
  frameEls.clear();
  if (!frameLayerEl) return;
  frameLayerEl.innerHTML = '';

  const frag = document.createDocumentFragment();
  for (const frame of state.frames) {
    const el = document.createElement('div');
    el.className = 'frame';
    el.dataset.id = frame.id;

    const outline = document.createElement('div');
    outline.className = 'frame-outline';
    el.appendChild(outline);

    // Grab strips over the dashed border move the frame; the handles resize it.
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      const strip = document.createElement('div');
      strip.className = 'frame-edge';
      strip.dataset.edge = edge;
      el.appendChild(strip);
    }
    for (const dir of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const handle = document.createElement('div');
      handle.className = 'frame-handle';
      handle.dataset.dir = dir;
      el.appendChild(handle);
    }

    const title = document.createElement('div');
    title.className = 'frame-title';
    title.textContent = frame.title || '';
    title.title = 'Drag to move · double-click to rename';
    el.appendChild(title);

    frameEls.set(frame.id, el);
    frag.appendChild(el);
  }
  frameLayerEl.appendChild(frag);
}

export function renderFrameTransforms() {
  for (const frame of state.frames) {
    const el = frameEls.get(frame.id);
    if (!el) continue;
    el.style.transform = `translate(${frame.x}px, ${frame.y}px)`;
    el.style.width = `${frame.w}px`;
    el.style.height = `${frame.h}px`;
    el.classList.toggle('selected', state.frameSelection.has(frame.id));
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function renderLines() {
  lineEls.clear();
  previewLineEl = null;
  if (!lineLayerEl) return;
  lineLayerEl.innerHTML = '';
  ensureLineMarkers(); // the arrowheads went out with everything else

  const frag = document.createDocumentFragment();
  for (const line of state.lines) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'line-group');
    g.dataset.id = line.id;

    const hit = document.createElementNS(SVG_NS, 'line');
    hit.setAttribute('class', 'line-hit');
    const visible = document.createElementNS(SVG_NS, 'line');
    visible.setAttribute('class', 'line');

    g.appendChild(hit);
    g.appendChild(visible);
    // `marker` caches the arrowhead currently on the element: this runs on
    // every pointer move, and re-setting an unchanged attribute is not free.
    lineEls.set(line.id, { g, hit, visible, marker: '' });
    frag.appendChild(g);
  }

  previewLineEl = document.createElementNS(SVG_NS, 'line');
  previewLineEl.setAttribute('class', 'line-preview');
  previewLineEl.style.display = 'none';
  frag.appendChild(previewLineEl);

  lineLayerEl.appendChild(frag);
}

/**
 * Where the segment from `from` crosses the box of the item centred on `to`.
 * Falls back to the centre when the two centres are closer than that edge --
 * the connector is buried at that point anyway, so there is nothing to show.
 */
function edgePoint(from, to, size) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!len) return to;
  const ux = dx / len;
  const uy = dy / len;
  let s = Infinity;
  if (ux) s = Math.min(s, (size.w / 2) / Math.abs(ux));
  if (uy) s = Math.min(s, (size.h / 2) / Math.abs(uy));
  if (!Number.isFinite(s) || s >= len) return to;
  return { x: to.x - ux * s, y: to.y - uy * s };
}

// Endpoints are read from wherever the two items are right now, so this is
// all a line ever needs: drag either end and the connector follows.
export function renderLineTransforms() {
  for (const line of state.lines) {
    const els = lineEls.get(line.id);
    if (!els) continue;
    const a = findItem(line.a);
    const b = findItem(line.b);
    if (!a || !b) {
      els.g.style.display = 'none';
      continue;
    }
    els.g.style.display = '';
    const ca = itemCenter(a);
    const cb = itemCenter(b);
    els.hit.setAttribute('x1', ca.x);
    els.hit.setAttribute('y1', ca.y);
    els.hit.setAttribute('x2', cb.x);
    els.hit.setAttribute('y2', cb.y);
    els.g.classList.toggle('selected', state.lineSelection.has(line.id));

    // Rules are re-measured here rather than cached: the offset changes with
    // every drag of either end, so there is nothing to invalidate.
    const ev = evaluateLine(line);
    const broken = ev.constrained && !ev.ok;
    els.g.classList.toggle('constrained', ev.constrained);
    els.g.classList.toggle('broken', broken);

    // Lines paint behind the icons, so an arrowhead sitting on b's centre is
    // buried by anything larger than the head itself. A constrained line stops
    // at b's edge instead, which is the only place the head can be seen.
    const end = ev.constrained ? edgePoint(ca, cb, itemSize(b)) : cb;
    els.visible.setAttribute('x1', ca.x);
    els.visible.setAttribute('y1', ca.y);
    els.visible.setAttribute('x2', end.x);
    els.visible.setAttribute('y2', end.y);

    // The attribute, not the CSS property: a bare url(#id) in an external
    // stylesheet resolves against the stylesheet, not the document.
    const marker = ev.constrained ? `url(#${broken ? ARROW_BROKEN_ID : ARROW_OK_ID})` : '';
    if (els.marker !== marker) {
      els.marker = marker;
      if (marker) els.visible.setAttribute('marker-end', marker);
      else els.visible.removeAttribute('marker-end');
    }
  }
  renderLinePreview();
}

function renderLinePreview() {
  if (!previewLineEl) return;
  const anchor = pendingLineFrom ? findItem(pendingLineFrom) : null;
  if (!anchor || !linePreviewPoint) {
    previewLineEl.style.display = 'none';
    return;
  }
  const c = itemCenter(anchor);
  previewLineEl.style.display = '';
  previewLineEl.setAttribute('x1', c.x);
  previewLineEl.setAttribute('y1', c.y);
  previewLineEl.setAttribute('x2', linePreviewPoint.x);
  previewLineEl.setAttribute('y2', linePreviewPoint.y);
}

export function renderTransforms() {
  renderFrameTransforms();
  renderLineTransforms();
  for (const item of state.items) {
    const el = itemEls.get(item.id);
    if (!el) continue;
    el.style.transform = `translate(${item.x}px, ${item.y}px)`;
    el.classList.toggle('selected', state.selection.has(item.id));
    el.classList.toggle('line-anchor', item.id === pendingLineFrom);
  }
  updateRulesReadout(); // dx/dy track the drag, so they are read live
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

// ---------------------------------------------------------------------------
// Frame titles
// ---------------------------------------------------------------------------

// Renaming is driven from drag.js's pointerdown (a second click on a title),
// not from a `dblclick` listener: the first click captures the pointer on
// #viewport, and a captured pointer makes the browser retarget the subsequent
// click/dblclick to the capture element -- so a delegated dblclick here would
// never see the title at all.
export function beginFrameTitleEdit(frameId) {
  const titleEl = frameEls.get(frameId)?.querySelector('.frame-title');
  if (!titleEl || titleEl.isContentEditable) return;
  beginTitleEdit(titleEl);
}

function beginTitleEdit(titleEl) {
  const frame = findFrame(titleEl.closest('.frame')?.dataset.id);
  if (!frame) return;
  const original = frame.title || '';

  titleEl.classList.add('editing');
  titleEl.contentEditable = 'true';
  titleEl.spellcheck = false;
  titleEl.focus();

  const range = document.createRange();
  range.selectNodeContents(titleEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let settled = false;
  const finish = (commit) => {
    if (settled) return;
    settled = true;
    titleEl.removeEventListener('keydown', onEditKey);
    titleEl.removeEventListener('blur', onBlur);
    titleEl.contentEditable = 'false';
    titleEl.classList.remove('editing');

    const next = titleEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (commit && next !== original) {
      pushUndo();
      frame.title = next;
      markDirty();
    }
    titleEl.textContent = frame.title || '';
    window.getSelection()?.removeAllRanges();
  };

  function onEditKey(e) {
    e.stopPropagation(); // board shortcuts stand down while a title is open
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
      titleEl.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
      titleEl.blur();
    }
  }
  function onBlur() {
    finish(true);
  }

  titleEl.addEventListener('keydown', onEditKey);
  titleEl.addEventListener('blur', onBlur);
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

// ---------------------------------------------------------------------------
// Rules panel
//
// A right-hand dock, up only while lines are selected. With several lines
// picked it shows the first one's numbers -- there is no sensible average of
// two offsets -- but every button acts on the whole selection.
// ---------------------------------------------------------------------------

// How far either side of the current offset a fresh rule reaches, in world px.
// A cell of slack: enough that the pair it was made from is comfortably inside.
const RULE_SLACK = 32;

function selectedLines() {
  const out = [];
  for (const id of state.lineSelection) {
    const line = findLine(id);
    if (line) out.push(line);
  }
  return out;
}

// Icons have no names of their own, so the file they show is the best label.
function lineEndName(itemId) {
  return findItem(itemId)?.src || itemId;
}

function fmtSigned(n) {
  const v = Object.is(n, -0) ? 0 : n;
  const s = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return v > 0 ? `+${s}` : s;
}

function fmtBound(v, side) {
  if (v === null || v === undefined) return side === 'min' ? '−∞' : '∞';
  return String(v);
}

// An empty field is that side's infinity; anything unreadable is treated the
// same way, so a half-typed "-" never silently becomes a real bound.
function parseBound(text) {
  const s = String(text).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function renderRulesPanel() {
  if (!rulesPanelEl) return;
  const lines = selectedLines();
  const open = lines.length > 0;
  rulesPanelEl.hidden = !open;
  appEl?.classList.toggle('rules-open', open);
  ruleRowEls.clear();
  if (!open) return;

  const line = lines[0];
  rulesTitleEl.textContent = lines.length === 1 ? 'LINE' : `LINE · ${lines.length} selected`;
  rulesEndsEl.textContent = `${lineEndName(line.a)} → ${lineEndName(line.b)}`;

  rulesListEl.innerHTML = '';
  const results = evaluateLine(line).results;
  for (const res of results) rulesListEl.appendChild(buildRuleRow(line, res.rule));
  if (!results.length) {
    const hint = document.createElement('p');
    hint.className = 'rules-empty';
    hint.textContent = 'No rules on this line. Attach one, or make one from where it sits now.';
    rulesListEl.appendChild(hint);
  }

  renderAttachOptions(line);
  updateRulesReadout();
}

function buildRuleRow(line, rule) {
  const row = document.createElement('div');
  row.className = 'rule-row';
  row.dataset.ruleId = rule.id;

  const head = document.createElement('div');
  head.className = 'rule-head';

  const mark = document.createElement('span');
  mark.className = 'rule-mark';
  head.appendChild(mark);

  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'rule-name';
  name.value = rule.name || '';
  bindRuleField(
    name,
    () => rule.name,
    () => { rule.name = name.value.trim().slice(0, 60) || rule.name; name.value = rule.name; },
  );
  head.appendChild(name);

  // Reads as part of the rule's name -- "not row gap" -- because that is what
  // it does: the ranges below stay put, the verdict flips.
  const notLabel = document.createElement('label');
  notLabel.className = 'rule-not';
  notLabel.title = 'Invert: the rule passes when the offset is OUTSIDE these ranges';
  const notBox = document.createElement('input');
  notBox.type = 'checkbox';
  notBox.checked = !!rule.invert;
  notBox.addEventListener('change', () => {
    pushUndo();
    rule.invert = notBox.checked;
    commitRuleChange();
  });
  notLabel.appendChild(notBox);
  notLabel.appendChild(document.createTextNode('not'));
  head.appendChild(notLabel);

  head.appendChild(ruleButton('⊘', 'Detach from the selected line(s)', () => {
    pushUndo();
    for (const l of selectedLines()) detachRule(l.id, rule.id);
    commitRuleChange();
  }));
  head.appendChild(ruleButton('🗑', 'Delete from the library, everywhere', () => {
    pushUndo();
    removeRule(rule.id);
    commitRuleChange();
  }));
  row.appendChild(head);

  row.classList.toggle('inverted', !!rule.invert);
  row._mark = mark;
  row._actual = {};
  for (const axis of ['x', 'y']) {
    const { el, actual } = buildAxisRow(line, rule, axis);
    row._actual[axis] = actual;
    row.appendChild(el);
  }

  row._name = name;
  ruleRowEls.set(rule.id, row);
  return row;
}

function buildAxisRow(line, rule, axis) {
  const el = document.createElement('div');
  el.className = 'rule-axis';

  const label = document.createElement('label');
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = !!rule[axis];
  label.appendChild(toggle);
  label.appendChild(document.createTextNode(axis));
  el.appendChild(label);

  const min = boundInput(rule, axis, 'min');
  const max = boundInput(rule, axis, 'max');
  el.appendChild(min);
  el.appendChild(document.createTextNode('..'));
  el.appendChild(max);

  const actual = document.createElement('span');
  actual.className = 'rule-actual';
  el.appendChild(actual);

  toggle.addEventListener('change', () => {
    pushUndo();
    if (toggle.checked) {
      // Arming an axis starts from where the line sits now, the same place a
      // brand new rule starts from: an axis that switched on as -∞‥∞ would
      // read as a constraint while constraining nothing.
      const ev = evaluateLine(line);
      const d = snap(axis === 'x' ? ev.dx : ev.dy);
      rule[axis] = { min: d - RULE_SLACK, max: d + RULE_SLACK };
    } else {
      rule[axis] = null;
    }
    markDirty();
    renderLineTransforms();
    renderRulesPanel();
  });

  return { el, actual };
}

function boundInput(rule, axis, side) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rule-bound';
  input.disabled = !rule[axis];
  input.value = rule[axis] ? fmtBound(rule[axis][side], side) : '';
  input.placeholder = side === 'min' ? '−∞' : '∞';
  input.title = `${axis} ${side} (blank = ${side === 'min' ? 'no lower' : 'no upper'} bound)`;
  bindRuleField(
    input,
    () => rule[axis]?.[side] ?? null,
    () => {
      if (!rule[axis]) return;
      rule[axis][side] = parseBound(input.value);
      input.value = fmtBound(rule[axis][side], side);
    },
  );
  return input;
}

function ruleButton(text, title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rule-btn';
  btn.title = title;
  btn.textContent = text;
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * Wire one panel field. The snapshot goes in on focus, because the field edits
 * the live rule -- by the time a value has been typed there is nothing left to
 * snapshot. An edit that changed nothing drops its snapshot again, so clicking
 * through the fields costs no history.
 *
 * `read` is called before and after to decide that; committing does not rebuild
 * the panel, so tabbing from one field to the next keeps working.
 */
function bindRuleField(input, read, write) {
  let before = null;

  input.addEventListener('focus', () => {
    before = read();
    pushUndo();
    input.select();
  });

  input.addEventListener('blur', () => {
    write();
    if (read() === before) discardUndo();
    else markDirty();
    renderLineTransforms();
    renderAttachOptions(selectedLines()[0]);
    updateRulesReadout();
    updateStatusBar();
  });

  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // board shortcuts stand down while a field is open
    // Esc leaves the field, not the panel: the panel is the selection, and
    // throwing that away over a typo would be a strange trade.
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      input.blur();
    }
  });
}

// Refresh everything a structural change touches: the board, the panel, and
// the broken tally in the status bar.
function commitRuleChange() {
  markDirty();
  renderLineTransforms();
  renderRulesPanel();
  // The rebuild takes the focused control away with it, and an element removed
  // while focused does not reliably fire focusout -- which would leave the
  // board's keyboard suspended with nothing on screen to explain why.
  if (!rulesPanelEl?.contains(document.activeElement)) setModalOpen(false);
}

function renderAttachOptions(line) {
  if (!rulesAttachEl || !line) return;
  rulesAttachEl.innerHTML = '';
  const head = document.createElement('option');
  head.value = '';
  head.textContent = '+ attach ▾';
  rulesAttachEl.appendChild(head);

  const attached = new Set(line.rules || []);
  let any = false;
  for (const rule of state.rules) {
    if (attached.has(rule.id)) continue;
    const opt = document.createElement('option');
    opt.value = rule.id;
    opt.textContent = rule.name || rule.id;
    rulesAttachEl.appendChild(opt);
    any = true;
  }
  rulesAttachEl.disabled = !any;
  rulesAttachEl.value = '';
}

/**
 * The cheap half: numbers and pass marks only, no rebuild. Called from
 * renderTransforms(), so it runs on every frame of a drag and must never touch
 * the fields the user may be typing into.
 */
function updateRulesReadout() {
  if (!rulesPanelEl || rulesPanelEl.hidden) return;
  const line = selectedLines()[0];
  if (!line) return;

  const ev = evaluateLine(line);
  rulesDxEl.textContent = fmtSigned(ev.dx);
  rulesDyEl.textContent = fmtSigned(ev.dy);

  for (const res of ev.results) {
    const row = ruleRowEls.get(res.rule.id);
    if (!row) continue;
    row.classList.toggle('broken', !res.ok);
    row._mark.textContent = res.ok ? '✓' : '✗';
    for (const axis of ['x', 'y']) {
      // The range is already on screen; only an axis that caused the failure
      // needs the live value spelled out next to it. Which axis that is flips
      // with the rule: normally the one outside its range, inverted the one
      // that sat inside it.
      const blamed = res.rule.invert ? res[axis] === true : res[axis] === false;
      row._actual[axis].textContent =
        !res.ok && blamed ? `(${fmtSigned(axis === 'x' ? ev.dx : ev.dy)})` : '';
    }
  }
}

function nextRuleName() {
  const taken = new Set(state.rules.map((r) => r.name));
  let n = state.rules.length + 1;
  while (taken.has(`rule ${n}`)) n++;
  return `rule ${n}`;
}

// A new rule describes what is already on the board: the offset the line has
// right now, snapped, with a cell of slack. Made to be nudged, not typed from
// scratch -- hence the focused, selected name field.
function newRuleForSelection() {
  const lines = selectedLines();
  if (!lines.length) return;

  pushUndo();
  const ev = evaluateLine(lines[0]);
  const sx = snap(ev.dx);
  const sy = snap(ev.dy);
  const rule = addRule({
    id: uid(),
    name: nextRuleName(),
    x: { min: sx - RULE_SLACK, max: sx + RULE_SLACK },
    y: { min: sy - RULE_SLACK, max: sy + RULE_SLACK },
    invert: false,
  });
  for (const line of lines) attachRule(line.id, rule.id);
  commitRuleChange();
  ruleRowEls.get(rule.id)?._name.focus();
}

function swapSelectedLineEnds() {
  const ids = [...state.lineSelection];
  if (!ids.length) return;
  pushUndo();
  swapLineEnds(ids);
  commitRuleChange();
}

function initRulesPanel() {
  if (!rulesPanelEl) return;

  // Board shortcuts stand down for anything focused in here, not just text
  // fields: Delete while a button has focus should not eat the line.
  rulesPanelEl.addEventListener('focusin', () => setModalOpen(true));
  rulesPanelEl.addEventListener('focusout', () => setModalOpen(false));

  rulesAttachEl?.addEventListener('change', () => {
    const ruleId = rulesAttachEl.value;
    rulesAttachEl.value = '';
    if (!ruleId) return;
    const lines = selectedLines();
    if (!lines.length) return;
    pushUndo();
    for (const line of lines) attachRule(line.id, ruleId);
    commitRuleChange();
  });

  rulesNewBtn?.addEventListener('click', () => newRuleForSelection());

  rulesSwapBtn?.addEventListener('click', () => {
    swapSelectedLineEnds();
    // Hand the keyboard back to the board; a button that keeps focus would
    // keep the shortcuts suspended for no reason.
    rulesSwapBtn.blur();
  });
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
  const sel = state.selection.size + state.frameSelection.size + state.lineSelection.size;
  const frames = state.frames.length;
  const lines = state.lines.length;
  const dirtyText = state.dirty ? 'unsaved changes' : 'saved';
  const frameText = frames ? ` · ${frames} frame${frames === 1 ? '' : 's'}` : '';
  const lineText = lines ? ` · ${lines} line${lines === 1 ? '' : 's'}` : '';
  // Only worth a word when something is actually broken; a standing "0 broken"
  // is noise on a board that carries no rules at all.
  const broken = brokenLineCount();
  const brokenText = broken ? ` · ${broken} rule${broken === 1 ? '' : 's'} broken` : '';
  const modeText = lineMode ? 'line tool — click two icons · ' : '';
  statusbarEl.textContent =
    `${modeText}${count} item${count === 1 ? '' : 's'}${frameText}${lineText}${brokenText}` +
    ` · ${sel} selected · grid ${state.grid}px · ${dirtyText}`;
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
  if (!state.items.length && !state.frames.length) {
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
  for (const frame of state.frames) {
    minX = Math.min(minX, frame.x);
    minY = Math.min(minY, frame.y);
    maxX = Math.max(maxX, frame.x + frame.w);
    maxY = Math.max(maxY, frame.y + frame.h);
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
    frames: state.frames.map(({ id, x, y, w, h, title }) => ({ id, x, y, w, h, title })),
    lines: state.lines.map(({ id, a, b, rules }) => ({ id, a, b, rules: [...(rules || [])] })),
    rules: state.rules.map(({ id, name, x, y, invert }) => ({
      id, name, x: cloneRange(x), y: cloneRange(y), invert: invert === true,
    })),
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
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
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
  if (mod && key.toLowerCase() === 'b') {
    e.preventDefault();
    addFrame();
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
    // In the line tool, Esc drops a half-drawn line first and leaves the tool
    // only on a second press, so one stray click is cheap to take back.
    if (lineMode) {
      if (pendingLineFrom) cancelPendingLine();
      else toggleLineMode(false);
      return;
    }
    setSelection([]);
    return;
  }
  if (!mod && key.toLowerCase() === 'l') {
    toggleLineMode();
    return;
  }
  // Only with lines picked: a rule is directional, so flipping the origin is
  // the one thing you reach for constantly. Ctrl+S is save and is caught above.
  if (!mod && key.toLowerCase() === 's' && state.lineSelection.size) {
    e.preventDefault();
    swapSelectedLineEnds();
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

  if (addFrameBtn) {
    addFrameBtn.addEventListener('click', () => addFrame());
  }

  if (lineToolBtn) {
    lineToolBtn.addEventListener('click', () => toggleLineMode());
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
  state.frames = (Array.isArray(layout.frames) ? layout.frames : [])
    .filter((f) => f && typeof f.id === 'string'
      && Number.isFinite(f.x) && Number.isFinite(f.y)
      && Number.isFinite(f.w) && Number.isFinite(f.h))
    .map((f) => ({
      id: f.id,
      x: f.x,
      y: f.y,
      w: Math.max(FRAME_MIN, f.w),
      h: Math.max(FRAME_MIN, f.h),
      title: typeof f.title === 'string' ? f.title : '',
    }));
  // Rules load before the lines that point at them, so the ids can be checked.
  state.rules = (Array.isArray(layout.rules) ? layout.rules : [])
    .map(normalizeRule)
    .filter(Boolean);
  const ruleIds = new Set(state.rules.map((r) => r.id));

  state.lines = (Array.isArray(layout.lines) ? layout.lines : [])
    .filter((l) => l && typeof l.id === 'string' && typeof l.a === 'string' && typeof l.b === 'string')
    // An id with no rule behind it is dropped rather than carried: it does
    // nothing today and would attach itself to whatever reused the id later.
    // A file written before rules existed simply has none, which is the same
    // as a line with an empty list.
    .map(({ id, a, b, rules }) => ({
      id,
      a,
      b,
      rules: (Array.isArray(rules) ? rules : []).filter((rid) => ruleIds.has(rid)),
    }));
  pruneDanglingLines();
}

function cloneRange(range) {
  return range ? { min: range.min ?? null, max: range.max ?? null } : null;
}

// undefined means "malformed, drop the whole rule"; null means the legitimate
// "this axis is not constrained". Keeping them apart is why this is not a
// plain ?? chain.
function normalizeRange(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return undefined;
  const min = raw.min === null || raw.min === undefined ? null : raw.min;
  const max = raw.max === null || raw.max === undefined ? null : raw.max;
  if (min !== null && !Number.isFinite(min)) return undefined;
  if (max !== null && !Number.isFinite(max)) return undefined;
  return { min, max };
}

function normalizeRule(raw) {
  if (!raw || typeof raw.id !== 'string') return null;
  const x = normalizeRange(raw.x);
  const y = normalizeRange(raw.y);
  if (x === undefined || y === undefined) return null;
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : raw.id,
    x,
    y,
    invert: raw.invert === true, // anything else, missing included, is the plain reading
  };
}

async function boot() {
  initToolbar();
  initRulesPanel();
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
