// drag.js — pointer interaction layer for imgnote.
//
// Owns: item dragging (+ live snap, group drag, Alt+drag duplicate), marquee
// selection, shift-click toggle, pan (middle-drag / Space+drag), zoom
// (Ctrl/Cmd+wheel) and wheel panning, palette drag-out, and hover -> hull
// tracking. Everything else (toolbar, keyboard shortcuts other than drag
// modifiers, palette list, undo stack management, saving) belongs to app.js.
//
// All gesture state lives in one `activeDrag` object so a single pointer
// capture + rAF loop can drive every kind of drag through the same pipeline.

import {
  state,
  renderTransforms,
  applyView,
  setHoveredGroup,
  pushUndo,
  markDirty,
  screenToWorld,
  snap,
  snapDelta,
  itemsInRect,
  expandToGroups,
  setSelection,
  selectedItems,
  addInstance,
  duplicateSelection,
  rollback,
} from './app.js';

const DRAG_THRESHOLD = 3; // px in screen space before a click becomes a drag

const viewport = document.getElementById('viewport');
const marquee = document.getElementById('marquee');
const paletteList = document.getElementById('palette-list');

let activeDrag = null;     // the single in-progress gesture, or null
let spaceHeld = false;     // Space bar state, tracked independently of pointer modifiers
let frameQueued = false;   // rAF coalescing flag
let lastHoveredGroup = null;

export function initInteractions() {
  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onPointerMove);
  viewport.addEventListener('pointerup', onPointerUp);
  viewport.addEventListener('pointercancel', onPointerCancel);
  viewport.addEventListener('pointerleave', onViewportLeave);
  viewport.addEventListener('wheel', onWheel, { passive: false });

  // Palette drag-out is the one gesture that has to start outside #viewport.
  paletteList?.addEventListener('pointerdown', onPalettePointerDown);

  // Space is not a pointer modifier, so it needs its own key tracking.
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
}

// ---------------------------------------------------------------------------
// Pointer dispatch
// ---------------------------------------------------------------------------

function onPointerDown(e) {
  if (!e.isPrimary) return;

  if (e.button === 1) {
    // Middle-mouse always pans, regardless of what is underneath it.
    e.preventDefault();
    startPan(e);
    return;
  }
  if (e.button !== 0) return; // ignore right-click etc.

  if (spaceHeld) {
    startPan(e);
    return;
  }

  const itemEl = e.target.closest('.item');
  if (itemEl) {
    startItemDrag(e, itemEl);
    return;
  }

  // Anything else within #viewport is empty canvas.
  startMarquee(e);
}

function onPointerMove(e) {
  if (activeDrag && e.pointerId === activeDrag.pointerId) {
    activeDrag.currentClientX = e.clientX;
    activeDrag.currentClientY = e.clientY;
    requestFrame();
    return;
  }
  if (!activeDrag) handleHover(e);
}

function onPointerUp(e) {
  if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
  const d = activeDrag;
  d.currentClientX = e.clientX;
  d.currentClientY = e.clientY;

  switch (d.type) {
    case 'item': finalizeItemDrag(d); break;
    case 'marquee': finalizeMarquee(d); break;
    case 'pan': finalizePan(d); break;
    case 'palette': finalizePaletteDrag(d); break;
  }

  releaseCapture(e.pointerId);
  activeDrag = null;
  updatePanningClass();
}

function onPointerCancel(e) {
  if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
  if (activeDrag.type === 'marquee') marquee.hidden = true;
  if (activeDrag.type === 'palette') removePalettePreview(activeDrag);
  releaseCapture(e.pointerId);
  activeDrag = null;
  updatePanningClass();
}

function onViewportLeave() {
  if (!activeDrag && lastHoveredGroup !== null) {
    lastHoveredGroup = null;
    setHoveredGroup(null);
  }
}

function releaseCapture(pointerId) {
  try {
    viewport.releasePointerCapture(pointerId);
  } catch {
    /* already released or never captured — fine */
  }
}

// One rAF per frame coalesces however many pointermove events arrived.
function requestFrame() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => {
    frameQueued = false;
    if (!activeDrag) return;
    switch (activeDrag.type) {
      case 'item': updateItemDrag(); break;
      case 'marquee': updateMarquee(); break;
      case 'pan': updatePan(); break;
      case 'palette': updatePaletteDrag(); break;
    }
  });
}

function crossedThreshold(d) {
  const dist = Math.hypot(d.currentClientX - d.startClientX, d.currentClientY - d.startClientY);
  if (!d.moved && dist > DRAG_THRESHOLD) d.moved = true;
  return d.moved;
}

// ---------------------------------------------------------------------------
// 1 & 2. Item drag, group drag, Alt+drag duplicate
// ---------------------------------------------------------------------------

function startItemDrag(e, itemEl) {
  const id = itemEl.dataset.id;

  if (e.shiftKey) {
    toggleGroupSelection(id);
    return; // shift+click is a discrete toggle, not a drag starter
  }

  if (!state.selection.has(id)) {
    setSelection([id]); // expands to the whole group internally
  }

  const originalAnchor = state.items.find((it) => it.id === id);
  if (!originalAnchor) return;

  if (e.altKey) {
    // duplicateSelection() pushes its own undo snapshot (state before the
    // copy exists) — that single snapshot is exactly what one Undo should
    // restore to, so we must NOT also push here or Undo would take two steps.
    duplicateSelection(0, 0); // copies land exactly on top of the originals
  } else {
    pushUndo(); // plain move: nothing else will snapshot this, so we do it once here
  }

  const items = selectedItems();
  if (items.length === 0) return;

  // After a duplicate the ids have changed, so re-find the anchor by position
  // (duplicateSelection(0,0) means the copy sits at the exact original coords).
  const anchor = e.altKey
    ? items.find((it) => it.x === originalAnchor.x && it.y === originalAnchor.y) ?? items[0]
    : items.find((it) => it.id === id) ?? items[0];

  viewport.setPointerCapture(e.pointerId);

  activeDrag = {
    type: 'item',
    pointerId: e.pointerId,
    startClientX: e.clientX,
    startClientY: e.clientY,
    currentClientX: e.clientX,
    currentClientY: e.clientY,
    anchorStartX: anchor.x,
    anchorStartY: anchor.y,
    items: items.map((it) => ({ id: it.id, startX: it.x, startY: it.y })),
    moved: false,
    dx: 0,
    dy: 0,
  };
}

function updateItemDrag() {
  const d = activeDrag;
  crossedThreshold(d);

  // Snap the raw pointer delta ONCE (in world units), then apply that same
  // delta to every selected item — this is what keeps relative offsets fixed
  // during a multi-item or group drag instead of snapping each item alone.
  const rawDx = (d.currentClientX - d.startClientX) / state.view.zoom;
  const rawDy = (d.currentClientY - d.startClientY) / state.view.zoom;
  const { dx, dy } = snapDelta(rawDx, rawDy);
  d.dx = dx;
  d.dy = dy;

  for (const moved of d.items) {
    const item = state.items.find((it) => it.id === moved.id);
    if (item) {
      item.x = moved.startX + dx;
      item.y = moved.startY + dy;
    }
  }
  renderTransforms();
}

function finalizeItemDrag(d) {
  updateItemDrag(); // apply the final pointer position synchronously
  if (d.moved && (d.dx !== 0 || d.dy !== 0)) {
    markDirty();
  }
}

function toggleGroupSelection(id) {
  const groupIds = expandToGroups([id]);
  const alreadyIn = [...groupIds].every((gid) => state.selection.has(gid));
  const next = new Set(state.selection);
  for (const gid of groupIds) {
    if (alreadyIn) next.delete(gid);
    else next.add(gid);
  }
  setSelection(next);
}

// ---------------------------------------------------------------------------
// 3, 4 & 5. Marquee select, shift toggle (above), empty-click clears
// ---------------------------------------------------------------------------

function startMarquee(e) {
  viewport.setPointerCapture(e.pointerId);
  activeDrag = {
    type: 'marquee',
    pointerId: e.pointerId,
    startClientX: e.clientX,
    startClientY: e.clientY,
    currentClientX: e.clientX,
    currentClientY: e.clientY,
    additive: e.shiftKey,
    baseSelection: new Set(state.selection),
    moved: false,
  };
}

function updateMarquee() {
  const d = activeDrag;
  if (!crossedThreshold(d)) return; // don't show/act on a sub-threshold jitter

  const vpRect = viewport.getBoundingClientRect();
  const left = Math.min(d.startClientX, d.currentClientX);
  const top = Math.min(d.startClientY, d.currentClientY);
  const right = Math.max(d.startClientX, d.currentClientX);
  const bottom = Math.max(d.startClientY, d.currentClientY);

  // #marquee lives outside #canvas, in screen space — position it relative
  // to #viewport's own box, not the (possibly panned/zoomed) canvas.
  marquee.hidden = false;
  marquee.style.left = `${left - vpRect.left}px`;
  marquee.style.top = `${top - vpRect.top}px`;
  marquee.style.width = `${right - left}px`;
  marquee.style.height = `${bottom - top}px`;

  // Convert the same screen rect to world space for the hit test.
  const topLeft = screenToWorld(left, top);
  const bottomRight = screenToWorld(right, bottom);
  const worldRect = {
    x: topLeft.x,
    y: topLeft.y,
    w: bottomRight.x - topLeft.x,
    h: bottomRight.y - topLeft.y,
  };

  const touchedIds = itemsInRect(worldRect).map((it) => it.id);
  const expanded = expandToGroups(touchedIds);
  const next = d.additive ? union(d.baseSelection, expanded) : expanded;
  setSelection(next);
}

function finalizeMarquee(d) {
  updateMarquee();
  marquee.hidden = true;

  if (!d.moved) {
    // A plain click on empty canvas. Shift+click on empty space is a no-op;
    // an unmodified click clears the selection.
    if (!d.additive) setSelection([]);
  }
  // A real (possibly empty) marquee already applied its selection live —
  // an empty drag-and-release correctly clears the selection.
}

function union(a, b) {
  return new Set([...a, ...b]);
}

// ---------------------------------------------------------------------------
// 6. Pan — middle-drag or Space+drag
// ---------------------------------------------------------------------------

function startPan(e) {
  viewport.setPointerCapture(e.pointerId);
  activeDrag = {
    type: 'pan',
    pointerId: e.pointerId,
    startClientX: e.clientX,
    startClientY: e.clientY,
    currentClientX: e.clientX,
    currentClientY: e.clientY,
    startViewX: state.view.x,
    startViewY: state.view.y,
  };
  updatePanningClass();
}

function updatePan() {
  const d = activeDrag;
  state.view.x = d.startViewX + (d.currentClientX - d.startClientX);
  state.view.y = d.startViewY + (d.currentClientY - d.startClientY);
  applyView();
}

function finalizePan() {
  updatePan();
  // Pan is view state: not undoable, not a "dirty" content change.
}

function updatePanningClass() {
  const panning = spaceHeld || (activeDrag && activeDrag.type === 'pan');
  viewport.classList.toggle('panning', Boolean(panning));
}

function isTextInput(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

function onKeyDown(e) {
  if (e.code !== 'Space' || isTextInput(e.target)) return;
  e.preventDefault(); // stop the page from scrolling
  if (!spaceHeld) {
    spaceHeld = true;
    updatePanningClass();
  }
}

function onKeyUp(e) {
  if (e.code !== 'Space') return;
  spaceHeld = false;
  updatePanningClass();
}

// ---------------------------------------------------------------------------
// 7. Zoom (Ctrl/Cmd+wheel) and wheel panning
// ---------------------------------------------------------------------------

function onWheel(e) {
  e.preventDefault(); // never let the browser scroll the page or page-zoom

  if (e.ctrlKey || e.metaKey) {
    zoomAt(e.clientX, e.clientY, e.deltaY);
  } else if (e.shiftKey) {
    state.view.x -= e.deltaY;
    applyView();
  } else {
    state.view.y -= e.deltaY;
    applyView();
  }
  // View-only changes: no pushUndo, no markDirty.
}

function zoomAt(clientX, clientY, deltaY) {
  const oldZoom = state.view.zoom;
  const factor = Math.exp(-deltaY * 0.001);
  const newZoom = clamp(oldZoom * factor, 0.25, 4.0);
  if (newZoom === oldZoom) return;

  // Keep the world point under the cursor fixed on screen: read it before
  // changing zoom, then correct view.x/y by how far that same screen point
  // now maps to a different world point after the zoom change.
  const before = screenToWorld(clientX, clientY);
  state.view.zoom = newZoom;
  const after = screenToWorld(clientX, clientY);
  state.view.x += (after.x - before.x) * newZoom;
  state.view.y += (after.y - before.y) * newZoom;

  applyView();
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// ---------------------------------------------------------------------------
// 8. Palette drag-out
// ---------------------------------------------------------------------------

function onPalettePointerDown(e) {
  if (e.button !== 0) return;
  const paletteItemEl = e.target.closest('.palette-item');
  if (!paletteItemEl) return;
  const src = paletteItemEl.dataset.src;
  if (!src) return;

  // Capture on #viewport (not the palette element) so every subsequent
  // pointermove/up flows through the same generic dispatch as everything else.
  viewport.setPointerCapture(e.pointerId);

  activeDrag = {
    type: 'palette',
    pointerId: e.pointerId,
    src,
    startClientX: e.clientX,
    startClientY: e.clientY,
    currentClientX: e.clientX,
    currentClientY: e.clientY,
    moved: false,
    previewEl: null,
    createdId: null,
  };
}

function updatePaletteDrag() {
  const d = activeDrag;
  if (!crossedThreshold(d)) return;

  if (d.createdId) {
    dragCreatedInstance(d);
    return;
  }

  if (isOverViewport(d.currentClientX, d.currentClientY)) {
    spawnInstanceFromPalette(d);
  } else {
    showPalettePreview(d);
  }
}

function isOverViewport(x, y) {
  const r = viewport.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function showPalettePreview(d) {
  if (!d.previewEl) {
    const img = document.createElement('img');
    img.src = `/img/${encodeURIComponent(d.src)}`;
    img.alt = '';
    Object.assign(img.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '48px',
      height: '48px',
      opacity: '0.6',
      pointerEvents: 'none',
      zIndex: '9999',
      willChange: 'transform',
    });
    document.body.appendChild(img);
    d.previewEl = img;
  }
  d.previewEl.style.transform = `translate(${d.currentClientX - 24}px, ${d.currentClientY - 24}px)`;
}

function removePalettePreview(d) {
  if (d.previewEl) {
    d.previewEl.remove();
    d.previewEl = null;
  }
}

function spawnInstanceFromPalette(d) {
  removePalettePreview(d);

  // addInstance() pushes its own undo snapshot, marks dirty, and does the
  // one full DOM rebuild needed to create the new element — all before we
  // continue the gesture as a plain renderTransforms()-only drag.
  const world = screenToWorld(d.currentClientX, d.currentClientY);
  const item = addInstance(d.src, snap(world.x), snap(world.y));
  d.createdId = item.id;

  setSelection([item.id]);
}

function dragCreatedInstance(d) {
  const item = state.items.find((it) => it.id === d.createdId);
  if (!item) return;
  const world = screenToWorld(d.currentClientX, d.currentClientY);
  item.x = snap(world.x);
  item.y = snap(world.y);
  renderTransforms();
}

function finalizePaletteDrag(d) {
  removePalettePreview(d);

  // crossedThreshold(), not d.moved: a gesture that finished inside a single
  // frame never ran the rAF that would have set the flag.
  if (!crossedThreshold(d)) return; // plain click on a palette entry

  if (!d.createdId) {
    // A gesture fast enough to finish inside a single frame never ran the
    // rAF that normally spawns the instance. Spawn it here instead so a
    // quick flick from the palette onto the canvas still lands.
    if (!isOverViewport(d.currentClientX, d.currentClientY)) return;
    spawnInstanceFromPalette(d);
    return;
  }

  if (!isOverViewport(d.currentClientX, d.currentClientY)) {
    // Dropped back over the palette: cancel cleanly. rollback() restores the
    // snapshot addInstance() pushed and discards it, so a cancelled drag-out
    // leaves neither an instance nor an undo entry behind.
    rollback();
  }
  // Dropped over the canvas: addInstance() already pushed undo, marked
  // dirty and rendered — nothing further to do here.
}

// ---------------------------------------------------------------------------
// 9. Hover -> group hull
// ---------------------------------------------------------------------------

function handleHover(e) {
  const itemEl = e.target.closest('.item');
  const item = itemEl ? state.items.find((it) => it.id === itemEl.dataset.id) : null;
  const groupId = item ? item.group : null;

  if (groupId !== lastHoveredGroup) {
    lastHoveredGroup = groupId;
    setHoveredGroup(groupId);
  }
}
