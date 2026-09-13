# Build contract — imgnote

Read `SPEC.md` first; it is the source of truth for behavior. This file fixes the
interfaces between files so they can be written independently. Do not change any name
in this document. If something here seems wrong, implement it as written and note the
concern in your final report.

## File ownership

| File | Owner |
|---|---|
| `serve.py` | agent A |
| `public/index.html`, `public/style.css`, `public/app.js` | agent B |
| `public/drag.js` | agent C |
| `public/slice.js` | agent B |

Never edit a file you do not own.

## HTTP contract

`GET /files` returns:

```json
{
  "files": [ { "name": "sun.png", "size": 1234, "mtime": 1690000000.0 } ],
  "layout": null
}
```

`files` is sorted by name (case-insensitive). `layout` is the parsed contents of
`.imgnote.json`, or `null` when the file is absent or unparseable.

`GET /img/<name>` returns image bytes with a correct `Content-Type`, or 404.

`POST /import` takes `{"files": [{"name": "cat.png", "data": "<base64 image>"}]}`, validates
every entry (safe filename, allowed extension, base64 that decodes to bytes matching the
claimed image type) before writing anything, writes each one atomically into the image
folder, and returns `{"ok": true, "written": [...]}` with the names actually used —
a name already on disk is written as `name-2.png` rather than overwriting it. On failure it
returns a non-2xx status with `{"ok": false, "error": "<message>"}` and writes nothing.

`POST /layout` takes the layout object as a JSON body, writes it to
`<folder>/.imgnote.json` atomically, and returns `{"ok": true}`. On failure it returns a
non-2xx status with `{"ok": false, "error": "<message>"}`.

Unknown paths return 404. All responses set `Cache-Control: no-store`.

## DOM contract

```html
<div id="app">
  <aside id="palette">
    <input id="palette-filter">
    <div id="palette-list">
      <div class="palette-item" data-src="sun.png" draggable="false">
        <img src="/img/sun.png"><span class="palette-name">sun.png</span>
      </div>
    </div>
  </aside>
  <main id="viewport">          <!-- fixed, receives all pointer events -->
    <div id="grid-layer"></div> <!-- dot grid background -->
    <div id="canvas">           <!-- transform: translate(...) scale(...) -->
      <div class="item" data-id="i1" style="transform: translate(128px, 96px)">
        <img src="/img/sun.png" draggable="false">
      </div>
      <svg id="hull-layer"></svg>   <!-- group hulls, inside canvas space -->
    </div>
    <div id="marquee" hidden></div> <!-- screen space, not inside #canvas -->
  </main>
  <div id="toolbar">…</div>
  <div id="statusbar">…</div>
</div>
```

Item elements are positioned with `transform: translate(Xpx, Ypx)` where X and Y are
world coordinates. Selected items carry the class `selected`. Items whose `src` is
missing from disk carry the class `missing`.

## `app.js` public API

`drag.js` imports from `./app.js`. Every one of these must be exported.

```js
export const state;
// {
//   grid: number, showGrid: boolean, theme: 'dark'|'light',
//   view: { x: number, y: number, zoom: number },
//   items: [ { id, src, x, y, group } ],   // array order = paint order
//   groups: [ { id } ],
//   selection: Set<string>,                // item ids
//   files: Map<string, {name,size,mtime}>, // what exists on disk
//   dirty: boolean
// }

export function render();                  // full rebuild of item elements
export function renderTransforms();         // cheap: update item transforms + selection classes only
export function applyView();                // apply state.view to #canvas and #grid-layer
export function renderHulls();              // redraw group hulls for hovered/selected groups
export function setHoveredGroup(groupId);   // null to clear

export function pushUndo();                 // snapshot BEFORE a mutation
export function markDirty();                // set dirty flag + update status bar

export function screenToWorld(clientX, clientY);  // -> {x, y}
export function worldToScreen(x, y);              // -> {x, y}
export function snap(v);                          // -> nearest multiple of state.grid
export function snapDelta(dx, dy);                // -> {dx, dy} each snapped

export function itemAt(worldX, worldY);     // topmost hit item or null; uses rendered w/h
export function itemsInRect(rect);          // rect = {x, y, w, h} in world space, touch-select
export function expandToGroups(ids);        // Set<id> -> Set<id> including all groupmates
export function setSelection(ids);          // ids: iterable; replaces selection, re-renders
export function selectedItems();            // -> item[]

export function addInstance(src, x, y);     // append new item, return it
export function duplicateSelection(dx, dy); // copy selection incl. new group ids, select copies
export function removeSelection();

export function uid();                      // unique id string

export function setStatus(text);            // one-off status bar message
export async function refreshFiles();       // re-read /files, update state.files, render()
export function setModalOpen(open);         // suspend board keyboard shortcuts
```

## `slice.js` public API

```js
import { refreshFiles, setModalOpen, setStatus } from './app.js';
export function openSlicer(blob);   // show the slicer for an image blob
export function close();            // hide it, importing nothing
export function isOpen();           // -> boolean
```

`slice.js` builds its own DOM (an overlay appended to `<body>`) and is imported lazily by
`app.js` on the first paste, so a session that never pastes never loads it. It owns the
slicer dialog end to end: guides, slice selection, naming, PNG encoding and `POST /import`.
`app.js` owns the `paste` listener and the `#paste-image` toolbar button.

`app.js` calls `initInteractions()` from `./drag.js` once after its first render.

## `drag.js` public API

```js
import { … } from './app.js';
export function initInteractions();   // attach every pointer/keyboard handler
```

`drag.js` owns: marquee selection, item dragging with snap, group dragging, `Alt+drag`
duplicate, pan (middle-drag, Space+drag), zoom (Ctrl+wheel), wheel panning, palette
drag-out, and hover tracking that feeds `setHoveredGroup`.

`app.js` owns: everything else, including all keyboard shortcuts that are not drag
modifiers (`Ctrl+G`, `Ctrl+D`, `Ctrl+S`, `Ctrl+Z`, `Delete`, `0`, `F`, `\`), the palette
list, the toolbar, undo, and persistence.

## Coordinate rules

- World coordinates are what is stored in `items`.
- Screen to world: `(clientX - rect.left - view.x) / view.zoom`.
- World to screen: `x * view.zoom + view.x + rect.left`.
- Item rendered size comes from the loaded image's `naturalWidth`/`naturalHeight`,
  cached on the item element as `_w` / `_h`. SVGs reporting 0 fall back to 64.

## Verification required

Every agent must actually run its code before reporting done. Agent A runs the server and
curls each route. Agents B and C must confirm the page loads with no console errors —
`python3 -c` with a short script, or a note in the report if a browser is unavailable.
