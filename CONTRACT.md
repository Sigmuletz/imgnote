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

Line rules add no file. The rules panel, rule evaluation, the `S` shortcut and every
piece of rule state live in agent B's files (`index.html`, `style.css`, `app.js`);
`serve.py` and `drag.js` are unchanged by the feature.

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

The layout is opaque to the server: it is written and read back verbatim, so nothing in
this contract changes when its shape grows. Its shape is SPEC.md's data model, which as
of line rules carries a top-level `rules` library and a `rules` id array on each line:

```json
{
  "version": 1,
  "items": [ { "id": "i1", "src": "sun.png", "x": 128, "y": 96, "group": null } ],
  "frames": [],
  "lines": [ { "id": "l1", "a": "i1", "b": "i2", "rules": ["r1"] } ],
  "rules": [ { "id": "r1", "name": "one cell right", "x": { "min": 96, "max": 160 }, "y": null } ]
}
```

A missing `"rules"` key — on the layout or on a line — reads as `[]`.

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
      <div id="frame-layer">    <!-- first child: frames paint under every item -->
        <div class="frame" data-id="f1" style="transform: translate(96px, 64px); width: 320px; height: 240px">
          <div class="frame-outline"></div>          <!-- the dashed border -->
          <div class="frame-edge" data-edge="top"></div>    <!-- x4: move grips -->
          <div class="frame-handle" data-dir="nw"></div>    <!-- x8: resize -->
          <div class="frame-title">Weather</div>
        </div>
      </div>
      <svg id="line-layer" viewBox="-50000 -50000 100000 100000" preserveAspectRatio="none">
        <defs>                             <!-- the two arrowheads, rebuilt with the layer -->
          <marker id="line-arrow">…</marker>
          <marker id="line-arrow-broken">…</marker>
        </defs>
        <g class="line-group constrained broken" data-id="l1">
          <line class="line-hit"></line>   <!-- fat transparent stroke, takes the click -->
          <line class="line" marker-end="url(#line-arrow-broken)"></line> <!-- the visible dashes -->
        </g>
        <line class="line-preview"></line> <!-- rubber band while half-drawn -->
      </svg>
      <div class="item" data-id="i1" style="transform: translate(128px, 96px)">
        <img src="/img/sun.png" draggable="false">
      </div>
      <svg id="hull-layer" viewBox="-50000 -50000 100000 100000" preserveAspectRatio="none"></svg>
    </div>
    <div id="marquee" hidden></div> <!-- screen space, not inside #canvas -->
  </main>
  <aside id="rules-panel" hidden>  <!-- right dock; shown only while a line is selected -->
    <div id="rules-header">…</div>       <!-- LINE a → b, live signed dx/dy -->
    <div id="rules-list">…</div>         <!-- attached rules: ✓/✗, bounds, detach, delete -->
    <div id="rules-actions">…</div>      <!-- [+ attach ▾] [new rule] [⇄ swap ends] -->
  </aside>
  <div id="toolbar">…</div>
  <div id="statusbar">…</div>
</div>
```

Item elements are positioned with `transform: translate(Xpx, Ypx)` where X and Y are
world coordinates. Selected items carry the class `selected`. Items whose `src` is
missing from disk carry the class `missing`.

Frame elements are positioned the same way and sized with `width`/`height` in world px.
`.frame` itself is `pointer-events: none` so the canvas under a frame keeps working;
only `.frame-edge`, `.frame-handle` and `.frame-title` take the pointer. A selected
frame carries the class `selected`.

Both SVG layers (`#line-layer`, `#hull-layer`) carry a large viewport offset back to the
canvas origin, with a `viewBox` mapping user units 1:1 onto world coordinates (negatives
included). This is load-bearing: a zero-sized outermost `<svg>` paints nothing whatever
`overflow` says, which silently hid every line and every group hull.

Line endpoints are plain world coordinates on `<line>`, recomputed from the two items'
centres on every `renderTransforms()`. `#line-layer` is `pointer-events: none` and only
`.line-hit` takes the pointer. A selected line's `<g>` carries `selected`; the icon a
half-drawn line is anchored to carries `line-anchor`. `#viewport` carries `line-mode`
while the tool is armed.

A ruled line's `<g>` carries `constrained` (at least one live rule: dash-dot plus an
arrowhead) and, when any of those rules fails, `broken` as well (red and thicker).
Both are toggled in `renderLineTransforms()` from `evaluateLine(line)` at paint time;
neither is ever stored on the line.

`.line-hit` and `.line` no longer necessarily share endpoints. The hit stroke always
runs centre to centre; a `constrained` line's visible stroke stops where the segment
crosses b's icon box, so its arrowhead lands on the icon's edge instead of being buried
behind it, and falls back to the centre when the centres are closer than that edge.

The arrowheads are two `<marker>`s, `line-arrow` and `line-arrow-broken`, in a `<defs>`
inside `#line-layer`, applied to the visible line with a `marker-end` **attribute**.
Not CSS: a bare `url(#id)` in an external stylesheet resolves against the stylesheet,
not the document, and paints no head at all. The `<defs>` is rebuilt by the same
self-healing path that rebuilds the layer, so a constrained line can never be left
pointing at a marker that does not exist.

`#app` is a CSS **grid** of three columns, `var(--palette-w) 1fr var(--rules-w)`.
`#rules-panel` is the third column, mirroring `#palette` in the first: `--rules-w` is
`0px` until `#app` carries `rules-open`, which widens it to `240px`. So the panel
**pushes** the viewport rather than overlaying it — it is a dock like the palette, not a
floating panel. The `hidden` attribute on the panel and `rules-open` on `#app` move
together, and both follow `state.lineSelection` being non-empty.

## `app.js` public API

`drag.js` imports from `./app.js`. Every one of these must be exported.

```js
export const state;
// {
//   grid: number, showGrid: boolean, theme: 'dark'|'light',
//   view: { x: number, y: number, zoom: number },
//   items: [ { id, src, x, y, group } ],   // array order = paint order
//   groups: [ { id } ],
//   frames: [ { id, x, y, w, h, title } ], // drawn under every item
//   lines:  [ { id, a, b, rules: [ruleId] } ], // a/b are item ids; geometry is derived
//   rules:  [ { id, name, x: {min,max}|null, y: {min,max}|null } ], // per-board library
//   selection: Set<string>,                // item ids
//   frameSelection: Set<string>,           // frame ids
//   lineSelection: Set<string>,            // line ids; only one of the three is ever non-empty
//   files: Map<string, {name,size,mtime}>, // what exists on disk
//   dirty: boolean
// }

export function render();                  // full rebuild of item elements
export function renderTransforms();         // cheap: update item + frame + line geometry and selection classes
export function applyView();                // apply state.view to #canvas and #grid-layer
export function renderHulls();              // redraw group hulls for hovered/selected groups
export function setHoveredGroup(groupId);   // null to clear

export function pushUndo();                 // snapshot BEFORE a mutation
export function discardUndo();              // drop the last snapshot; state and selection untouched
export function markDirty();                // set dirty flag + update status bar

export function screenToWorld(clientX, clientY);  // -> {x, y}
export function worldToScreen(x, y);              // -> {x, y}
export function snap(v);                          // -> nearest multiple of state.grid
export function snapDelta(dx, dy);                // -> {dx, dy} each snapped

export function itemAt(worldX, worldY);     // topmost hit item or null; uses rendered w/h
export function itemsInRect(rect);          // rect = {x, y, w, h} in world space, touch-select
export function expandToGroups(ids);        // Set<id> -> Set<id> including all groupmates
export function setSelection(ids);          // ids: iterable; replaces item selection, clears frames
export function selectedItems();            // -> item[]

export function setFrameSelection(ids);     // replaces frame selection, clears item selection
export function selectedFrames();           // -> frame[]
export function findFrame(id);              // -> frame | null
export function itemsInFrame(frame);        // items whose centre is inside the frame rect
export function frameContentIds(frameIds);  // -> Set<item id>, expanded to whole groups
export function addFrame();                 // wrap the selection, or a default box in view; returns it
export function beginFrameTitleEdit(frameId); // open the in-place rename field on that frame
export const FRAME_MIN;                     // smallest frame a resize will produce, world px

export function setLineSelection(ids);      // replaces line selection, clears items and frames
export function findLine(id);               // -> line | null
export function isLineMode();               // -> boolean, the line tool is armed
export function toggleLineMode(force);      // arm/disarm the tool (omit force to toggle)
export function lineClickItem(itemId);      // one click of the two-click line gesture
export function lineTargetAt(wx, wy, tol);  // item at a world point, with tolerance slack
export function lineIsHidden(line);         // true when both icons cover the whole connector
export function pendingLineAnchor();        // -> item id of a half-drawn line, or null
export function cancelPendingLine();        // drop a half-drawn line, stay in the tool
export function updateLinePreview(wx, wy);  // move the rubber band to a world point

export function findRule(id);               // -> rule | null
export function addRule(rule);              // append to state.rules, return it
export function removeRule(id);             // drop from the library, strip the id from every line
export function attachRule(lineId, ruleId);
export function detachRule(lineId, ruleId);
export function evaluateLine(line);         // -> { dx, dy, constrained, ok, results: [{ rule, ok, x, y }] }
export function swapLineEnds(ids);          // swap a/b on each line id
export function brokenLineCount();          // -> how many lines have a failing rule
export function renderRulesPanel();         // rebuild the inspector for the current line selection

export function addInstance(src, x, y);     // append new item, return it
export function duplicateSelection(dx, dy); // copy selection incl. new group ids, select copies
export function removeSelection();

export function uid();                      // unique id string

export function setStatus(text);            // one-off status bar message
export async function refreshFiles();       // re-read /files, update state.files, render()
export function setModalOpen(open);         // suspend board keyboard shortcuts
```

`evaluateLine` measures centre to centre from `a` to `b`, so `dx`/`dy` are signed world
px with neither axis negated (`+dy` is b below a). A line with no live rules — none
attached, or every attached id dangling — returns `constrained: false, ok: true` and an
empty `results`. Each `results` entry's `x` and `y` is `true`, `false`, or `null` when
that axis is unconstrained on that rule; the entry's `ok` is the AND of the axes it does
constrain, and the line's `ok` is the AND of every entry.

`setModalOpen` stays the slicer's and the frame rename's. The rules panel does not use
it: `onKeyDown` already returns early for `modalOpen` and for any text input, and each
panel field stops propagation on its own keydown, so a focused field keeps the board
shortcuts quiet without a latch.

`removeRule` is the only thing that deletes a rule: it removes it from `state.rules` and
from every `line.rules` in one step. Ids left dangling by anything else are ignored by
`evaluateLine` and pruned when a layout is loaded.

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
duplicate, frame moving (border or title, carrying the frame's contents) and frame
resizing (the eight handles), the line tool's clicks, drag-to-connect and rubber band, line selection,
opening a frame rename (a second click on a title, which
`dblclick` cannot see because the first click captured the pointer), pan (middle-drag,
Space+drag), zoom (Ctrl+wheel), wheel
panning, palette drag-out, and hover tracking that feeds `setHoveredGroup`.

`app.js` owns: everything else, including all keyboard shortcuts that are not drag
modifiers (`Ctrl+G`, `Ctrl+D`, `Ctrl+B`, `Ctrl+S`, `Ctrl+Z`, `Delete`, `L`, `S`, `0`, `F`, `\`),
the palette list, the toolbar, frame title editing, line-tool state, undo, and persistence.

Line rules are entirely `app.js`: the rule library, `line.rules`, `evaluateLine`, the
`#rules-panel` and its inputs, the `S` shortcut and the broken-rule tally in the status
bar. `drag.js` gains nothing — it already moves items, and the panel's live `dx`/`dy`
comes from `renderRulesPanel()` being called out of `renderTransforms()`, which every
drag already drives.

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
