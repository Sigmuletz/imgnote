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
  "groups": [ { "id": "g1" } ]
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

Text notes, multiple named boards, z-order reordering, per-icon size overrides, icon
labels, live file watching, subdirectory recursion, and any modification or deletion of
image files that already exist (importing only ever adds new ones). The slicer does not
auto-detect cell boundaries, trim transparent margins, or import to anywhere but the
served folder.
