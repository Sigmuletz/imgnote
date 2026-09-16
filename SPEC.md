# imgnote — spec

Local-only icon composition board. Load images from a folder, drag them onto an
infinite canvas, snap to a configurable grid, multi-select, group, and duplicate
to try out orderings and combinations.

## Stack

- Server: `python3 serve.py <folder> [--port 5173]`, stdlib `http.server` only, binds 127.0.0.1.
- Client: vanilla JS (ES modules) + CSS, no build step, no dependencies.
- Existing image files are never modified or deleted. The app reads images, writes one
  JSON layout file, and adds new image files when the user imports slices of a pasted image.

```
serve.py
public/
  index.html
  app.js       state + render
  drag.js      pointer, selection, snap
  slice.js     clipboard slicer + import
  style.css
SPEC.md
```

## Routes

| Route | Purpose |
|---|---|
| `GET /` | app shell + static assets from `public/` |
| `GET /files` | `{files:[{name,size,mtime}], layout:{...}|null}` |
| `GET /img/<name>` | image bytes; path resolved and checked to stay inside the folder |
| `POST /layout` | write `.imgnote.json` (tmp file + atomic rename) |
| `POST /import` | write base64 image slices into the folder as new files |

Extension allowlist (case-insensitive): `.png .jpg .jpeg .gif .webp .svg .avif .bmp .ico`.
Dotfiles, subdirectories and all other extensions are ignored. Flat folder only.

## Data model

Board items are **instances**, not one-per-file: the same image can appear many times.

```json
{
  "version": 1,
  "grid": 32,
  "showGrid": true,
  "theme": "dark",
  "view": { "x": 0, "y": 0, "zoom": 1 },
  "items": [
    { "id": "i1", "src": "sun.png", "x": 128, "y": 96, "group": "g1" },
    { "id": "i2", "src": "sun.png", "x": 256, "y": 96, "group": null }
  ],
  "groups": [ { "id": "g1" } ],
  "frames": [ { "id": "f1", "x": 96, "y": 64, "w": 320, "h": 240, "title": "Weather" } ],
  "lines": [ { "id": "l1", "a": "i1", "b": "i2", "rules": ["r1"] } ],
  "rules": [ { "id": "r1", "name": "one cell right", "x": { "min": 96, "max": 160 }, "y": null } ]
}
```

Array order of `items` is paint order — last element draws on top.
Saved as `.imgnote.json` inside the image folder, so the layout travels with it.

## Canvas

- Infinite, pannable and zoomable. Overlap allowed, no bounds.
- Faint dot grid painted via a CSS background that scales with zoom; toggleable.
- Grid size is a single px value (default 32), live-editable, persisted. Changing it
  does **not** re-snap existing items; they keep their coordinates until next dragged.
- Icons render at true native size (`naturalWidth`/`naturalHeight`), no clamping,
  no filename labels. SVGs lacking intrinsic dimensions fall back to 64×64.
- Theme: dark board (`#1a1a1c`) by default, toggleable to light, persisted.

## Palette

Permanent left dock (~200px), collapsible, with a filename filter box.
Lists every file in the folder at a uniform 48px thumbnail size.
Dragging an entry onto the canvas spawns a new instance; the entry stays.
The board starts empty — every item on it was placed deliberately.

## Selection

- Drag on empty canvas: rubber-band marquee (touch-select).
- Shift+click: toggle an item in the selection.
- `Ctrl+A` select all, `Esc` or empty-click clears.
- Marquee touching any group member selects the whole group — groups are atomic.

## Groups

- `Ctrl+G` groups the selection, `Ctrl+Shift+G` ungroups.
- No names, no labels. Clicking any member selects and moves the entire group,
  preserving exact relative offsets.
- Fully atomic: to change an internal offset, ungroup, move, regroup.
- Membership is shown as a padded dashed bounding box (~8px padding) drawn only on
  hover or selection.

## Frames

A frame is a dashed, resizable box with a title, drawn **below every icon**. It is
scenery with one behaviour: moving it moves whatever stands on it.

- `Ctrl+B` or the toolbar's `Frame` button adds one — wrapped around the current
  selection with ~24px of padding when there is one, otherwise a 320×240 box in the
  middle of the view.
- Membership is **geometric, never stored**: a frame carries an item when that item's
  centre falls inside the frame's rect. Nothing is tagged, so dropping an icon into a
  frame or dragging it out is just moving it. The set is read once, when a frame drag
  starts; nothing joins or leaves mid-gesture.
- A carried set is expanded to whole groups, so a group straddling an edge still
  travels intact rather than being split.
- The frame's **interior is pointer-transparent**. Marquee selection, item drags and
  clicks inside a frame behave exactly as they do on bare canvas.
- Drag the dashed border or the title to move the frame; the eight handles resize it.
  Handles appear on hover or selection. Moving snaps the delta (as item drags do);
  resizing snaps each dragged edge to the grid and stops at a 32px minimum. Resizing
  never moves the contents — items join or leave by geometry alone.
- The title sits centred on the top edge, painted over the dashed line. Double-click
  to rename; `Enter` commits, `Esc` reverts, and board shortcuts stand down while the
  field is open.
- Items and frames are two selections that never hold at once: selecting one clears
  the other. `Shift+click` a border toggles a frame in the frame selection. Marquee
  selects items only — frames are picked up by their border or title.
- `Delete` removes selected frames and leaves everything that stood inside them.
  Frames are undoable and are saved in `.imgnote.json` like everything else.
- `Ctrl+D` does not duplicate frames; it stays an item operation.

## Lines

A line is a dashed connector between two items, drawn **behind every icon** and in
front of the frames.

- `L` or the toolbar's `Line` button arms the line tool; the button lights up and the
  cursor becomes a crosshair.
- Two clicks **or** one drag, whichever the hand reaches for: click an icon to anchor
  and click a second to connect, or press on one icon and release on another. Pressing
  and releasing on the same icon is a plain click and leaves the anchor armed. A rubber
  band follows the cursor in between, the anchored icon carries a dashed outline, and
  hovering an icon outlines what a click would connect to. The tool stays armed after
  each line, so a run of connections is one keypress and a series of clicks.
- Hit testing carries ~12px of screen-space slack around an icon, so a near miss on a
  small icon connects rather than doing nothing.
- Clicking the anchor again drops a half-drawn line, and so does `Esc`; a second `Esc`
  leaves the tool. A click that lands on nothing **keeps** the half-drawn line — a
  near miss silently throwing the anchor away reads as the tool being broken.
- Any number of lines may leave one icon. An icon cannot connect to itself. A pair that
  is already connected is not doubled; instead the existing line is **selected**, so the
  refusal points at something visible that `Delete` can remove.
- Because lines pass behind the icons, two icons close enough together bury the whole
  connector. The status bar says so when a new line lands hidden, and again when a
  hidden pair is re-attempted — a silently invisible line reads as a broken tool.
- A line stores **two item ids, never coordinates**. Both endpoints are read from the
  items' centres at paint time, so dragging either end — or the frame it stands on —
  moves the line with it, at no cost.
- Lines are click-selectable through a fat invisible hit stroke, so a 2px dash is
  still catchable at any zoom. An icon always wins the click where the two overlap.
  `Shift+click` toggles a line in the selection. Items, frames and lines are three
  selections that never hold at once.
- `Delete` removes selected lines and leaves both icons. Deleting an **icon** takes
  every line that reached it.
- `Ctrl+D` / `Alt+drag` copy a line only when both of its ends are in the copied
  selection: the copies come out connected the same way, and a line reaching outside
  the selection is left on the originals rather than re-pointed at a copy.
- The frame and line layers are rebuilt if the page shell is missing them, so a layer
  that is absent can never silently swallow what is drawn into it. The two SVG layers
  carry an explicit viewport: a zero-sized outermost `<svg>` paints nothing, whatever
  `overflow` says.
- The line tool draws, it does not select: arming it clears the selection, and while
  it is armed the left button neither drags items nor marquees. Middle-drag and
  `Space+drag` still pan.
- A line can also carry positional rules; see **Line rules** below. A line with no
  rules on it behaves exactly as described here.

## Line rules

A line can carry **positional rules**: constraints on how the two icons it joins are
offset from each other. Rules are advisory — nothing snaps, blocks or reverts. A
broken rule turns the line red and the status bar counts it, and that is the whole of
the enforcement. The board stays a place to try arrangements out; a rule is a note
about one, not a cage around it.

### Measuring an offset

- Centre to centre, using the same two centres the line's endpoints already use, so a
  rule measures exactly what is drawn.
- The line's `a` — the icon clicked first when it was drawn — is always the origin:
  `dx = centre(b).x - centre(a).x`, `dy = centre(b).y - centre(a).y`.
- `+dx` means b is to the **right** of a; `+dy` means b is **below** a. These are raw
  world coordinates with neither axis negated, so a number stored in a rule always
  reads the same way round as the arithmetic on screen.
- `⇄ swap ends` in the panel, or the `S` key, exchanges `a` and `b`. Both offsets
  negate, so every rule attached to that line now means its mirror image. The rules
  themselves are never rewritten — swapping is how you say "I drew this the other way
  round", and it is the only thing that changes what a rule means.

### What a rule says

A rule is a name and up to two ranges:

```json
{ "id": "r1", "name": "one cell right", "x": { "min": 96, "max": 160 }, "y": null }
```

- A null axis is unconstrained. Within an axis the test is `min <= d <= max`,
  inclusive, against the **signed** offset. A blank `min` is -∞, a blank `max` is +∞.
- Because the comparison is signed, the sign of the bounds carries the direction:
  `40..200` means "to the right of a", `-200..-40` means "to the left", `-200..200`
  means "either side, within 200". One mechanism says both how far and which way.
- Bounds are world px and free integers — they are not snapped to the grid, so a rule
  can describe a spacing the grid has no cell for.
- Rules live in a **per-board library**; a line stores ids, not copies. Editing a
  rule's bounds re-tests every line that uses it at once, which is the point of a
  library: "the gap I want between a pair" is one idea, stated once.
- Several rules on one line combine with AND. Any broken rule makes the line broken.
- Deleting a rule from the library is immediate and unconfirmed — it is one `Ctrl+Z`
  away, like every other mutation. Lines still pointing at a dead id ignore it when
  they are evaluated, and those ids are pruned on load.

### What it looks like

| Line | Drawn as |
|---|---|
| no rules | grey dashed, exactly as before |
| rules, all passing | grey, dash-dot, plus an arrowhead at the `b` end |
| any rule broken | red and thicker, same dash-dot and arrowhead |

The arrowhead is what makes a ruled line readable without opening anything: a rule is
written from `a` to `b`, so `a → b` has to be visible on the board, not only in the
panel.

That head cannot sit on b's centre. Lines paint **behind** the icons, so an arrowhead
at the centre is swallowed by any icon bigger than the head itself. A ruled line's
visible segment therefore stops where it crosses b's icon box, leaving the head on the
edge of the icon it points at — which is why a ruled line looks slightly shorter than
the plain line between the same two icons. Only the drawing is trimmed: the click
target still runs centre to centre, so a ruled line is no harder to select. When the
two centres are already closer than that edge the segment falls back to the centre;
the connector is buried at that point regardless, and a buried one gets no special
treatment here — the status bar already says so when it happens, ruled or not.

The status bar appends ` · N rules broken`, and only when N is non-zero: a board that
satisfies everything says nothing about rules at all.

### The inspector

Rules are read and edited in a right-hand dock (~240px) that mirrors the palette on
the left. It is shown only while a line selection exists, and it **pushes** the
viewport rather than floating over it, so it can never hide the line being edited.

For the selected line it shows:

- a header, `LINE a → b`, naming the direction every number below is measured in;
- the live signed `dx` / `dy`, tracking a drag in real time rather than updating on
  release, so an icon can be dragged while the numbers walk into range;
- each attached rule with a ✓ or ✗ and its per-axis `min..max`; a failing axis also
  shows the actual value beside it, because "which number is wrong" is the first
  question a red line raises;
- name and bounds as editable fields with a per-axis on/off toggle, plus detach and
  delete;
- `[+ attach ▾]`, `[new rule]` and `[⇄ swap ends]`.

With several lines selected the panel shows the **first** line's numbers and rules — a
merged list of everything would be unreadable — but every action applies to the whole
selection. Attaching a rule with five lines selected attaches it five times.

`[new rule]` prefills from the selected line's live geometry, snapped to the grid and
widened by ±32 on both axes, both axes on, auto-named, and attached immediately. The
common case is "keep these roughly where they are now", so that is one button.

Board shortcuts stand down while a panel field has the focus, so typing `-200` into a
bounds field cannot fire `Delete`, `L`, `S`, `0`, `F` or `\`. The panel needs no modal
latch of its own for that: a keystroke aimed at a text field never reaches the board
handler in the first place. `Enter` and `Esc` both blur the field and leave the panel
open — it is a dock, not a dialog, and there is nothing to dismiss.

`S` swaps ends only while a line selection exists; with nothing selected it does
nothing. `Ctrl+S` is still save, and is matched before the bare key.

Undo treats a field as one editing session: a snapshot is pushed on focus and dropped
again on blur when nothing changed, so clicking through a field costs no history and a
typed change costs exactly one step. Attach, detach, delete, swap ends and new rule
are one snapshot each.

### Copying and saving

- `Ctrl+D` / `Alt+drag` still copy a line only when both of its ends are in the copied
  selection, and the copy comes out **bare**: the connection is duplicated, the rules
  are not. A duplicate is a sketch of an arrangement, and cloning constraints onto it
  would report breakage nobody asked for.
- `.imgnote.json` gains a top-level `"rules"` array beside `items`, `frames` and
  `lines`, and each line saves its own array of rule ids. A missing `"rules"` key
  reads as `[]`, so a board saved before this feature loads unchanged. `serve.py` is
  untouched — the layout is an opaque blob to the server.

## Dragging and snapping

- Live snap during drag — items step cell to cell, so what you see is what you get.
- For a multi-item or group drag, the **delta** is snapped once and applied to every
  selected item, so relative offsets never change.
- Anchor is the item under the cursor.

## Paste and slice

`Ctrl+V` with an image on the clipboard opens a modal slicer over the board. The
toolbar's `Paste image…` button is the same entry point via `navigator.clipboard.read()`,
which may be refused by the browser; the paste event always works. A paste carrying no
image is left alone, so pasting text into the filter box still behaves.

- The image is shown fitted to the dialog, never scaled above 1:1, on a checkerboard so
  transparency is readable. Guide positions and slice rects are always in **image pixels**;
  display scale is presentation only.
- Clicking the top ruler adds a vertical cut, the left ruler a horizontal one. Cuts are
  draggable, removed by double-click or by dragging clear of the image, capped at 63 per
  axis, and refused within 2px of an edge or another cut so no slice is empty.
- `Cols`/`Rows` + `Split` replaces all cuts with an even grid.
- n vertical and m horizontal cuts make (n+1)·(m+1) slices. Every slice starts selected;
  clicking toggles one and dragging paints a run. All / None / Invert act on everything.
- Changing the cuts does not scramble the selection: each excluded slice and custom name is
  re-anchored by the centre point of the slice it described, then reassigned to whichever
  new slice contains that point.
- Names come from a prefix: `prefix.png` for a single uncut slice, `prefix-r2c3.png`
  (1-based) in a grid. Any slice can be renamed individually in the side list; clearing the
  field restores the auto name. Names are sanitised to the server's allowlist.
- `Resize to W×H` exports every slice at that size instead of its natural crop size.
- `Import` encodes the selected slices as PNGs and POSTs them to `/import`; at most 512 per
  import. The dialog closes, the folder listing is re-read, and the new files appear in the
  palette without a reload. `Esc` closes without writing anything.
- **An existing file is never overwritten.** A colliding name is written as `name-2.png`,
  `name-3.png`, …, and the status bar reports how many were renamed.
- While the dialog is open it owns the keyboard: board shortcuts do not fire.

### `POST /import`

Body `{"files": [{"name": "cat.png", "data": "<base64>"}, ...]}`. Every entry is validated
and decoded before anything touches the disk, so a malformed request writes nothing:

- name must match `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$` — no separators, no leading dot
- extension must be in the image allowlist
- payload must be valid base64 whose leading bytes match the claimed image type
- at most 512 files and 64 MB of body

Writes go to a temp file and are renamed into place. Response is
`{"ok": true, "written": ["cat.png", "cat-2.png"]}` in request order.

## Duplication

- `Ctrl+D` duplicates the selection offset by one grid cell and selects the copy,
  so repeated presses lay out a row.
- `Alt+drag` pulls a duplicate off the original in one gesture.
- Duplicating a group produces a new, independent group with a fresh id and identical
  internal offsets. The two are unlinked.
- `Delete` / `Backspace` removes selected instances from the board only. Files on disk
  and palette entries are untouched.

## Arrange

Toolbar cluster, enabled at 2+ selected: align left / right / top / bottom / center-x /
center-y, and distribute evenly on x or y between the two extremes. Results re-snap to
the grid.

## Navigation

| Input | Action |
|---|---|
| wheel | pan y (shift+wheel: pan x) |
| Ctrl/⌘ + wheel | zoom at cursor, clamped 0.25×–4× |
| middle-drag, Space+drag | pan |
| `0` / `F` | reset zoom / fit all items |

## Undo

`Ctrl+Z` / `Ctrl+Shift+Z` (and `Ctrl+Y`) over a snapshot stack — every mutation pushes a
deep clone of the state, capped at 100 entries. Pan and zoom are view state and are not
undoable. History is cleared on reload.

## Saving

Explicit only: `Ctrl+S` writes `.imgnote.json`. A dirty indicator shows unsaved changes
and `beforeunload` warns before closing with unsaved work. The server writes to a temp
file and renames, so the JSON is never left half-written.

## Folder changes

The folder is read once on page load; there is no file watcher. Reload to pick up changes.

- A new file appears in the palette, ready to drag out. Nothing is auto-placed.
- A deleted file vanishes from the palette, but its board instances remain as dashed
  placeholders showing the filename, keeping position, group and z-order. Restoring the
  file restores the composition exactly.

## Keymap

```
drag empty canvas   marquee select
Shift+click         toggle selection
Ctrl+A / Esc        select all / clear
Ctrl+G              group
Ctrl+Shift+G        ungroup
Ctrl+B              add a frame
L                   line tool (click two icons; Esc to leave)
S                   swap the ends of the selected lines (flips what their rules mean;
                    needs a line selection, and Ctrl+S is still save)
Ctrl+D              duplicate (+1 grid cell)
Alt+drag            drag a duplicate
Delete/Backspace    remove instances from board
Ctrl+Z / Ctrl+Shift+Z   undo / redo
Ctrl+S              save
Ctrl+V              paste an image from the clipboard and slice it
0 / F               reset zoom / fit all
Space+drag          pan
\                   collapse palette
```

## Explicitly out of scope

Text notes (a frame title is a label on a box, not a note), multiple named boards,
nested frames, frames as stored membership, line labels, arrowheads on rule-free lines,
curved or right-angled routing, lines to anything but an item centre, rules that snap,
move or block anything, rules on distance or angle rather than signed axis offsets,
rules spanning more than the two ends of one line, a rule library shared between boards,
z-order reordering, per-icon size overrides, icon
labels, live file watching, subdirectory recursion, and any modification or deletion of
image files that already exist (importing only ever adds new ones). The slicer does not
auto-detect cell boundaries, trim transparent margins, or import to anywhere but the
served folder.
