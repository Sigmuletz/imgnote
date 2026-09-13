# imgnote

A local-only board for arranging image icons. Point it at a folder, drag icons
onto an infinite canvas, snap them to a grid, group them, and duplicate them to
try out orderings and combinations.

Existing image files are never modified or deleted. The app writes a single
`.imgnote.json` layout file inside the folder, and — only when you import
slices of a pasted image — new image files alongside them.

## Run

```sh
python3 serve.py ./icons          # then open http://127.0.0.1:5173
python3 serve.py ~/pics --port 8080
```

Python 3.12+, standard library only. No npm install, no build step, no
dependencies. The server binds to `127.0.0.1` and is not reachable from the
network.

On Windows, see [WINDOWS.md](WINDOWS.md) — a step-by-step setup from installing
Python through to a double-click launcher.

## Use

The left palette lists every image in the folder and never empties — drag an
entry onto the canvas to place an instance of it. The same image can be placed
as many times as you like, which is the point: you are composing arrangements,
not filing files.

| Input | Action |
|---|---|
| drag from palette | place a new instance |
| drag on empty canvas | rubber-band select |
| Shift+click | add/remove from selection |
| Ctrl+A / Esc | select all / clear |
| Ctrl+G / Ctrl+Shift+G | group / ungroup |
| Ctrl+D | duplicate, offset one grid cell |
| Alt+drag | drag a duplicate off the original |
| Delete | remove instances from the board (never deletes files) |
| Ctrl+Z / Ctrl+Shift+Z | undo / redo |
| Ctrl+S | save the layout |
| wheel / Shift+wheel | pan vertically / horizontally |
| Ctrl+wheel | zoom at the cursor (0.25×–4×) |
| middle-drag, Space+drag | pan |
| 0 / F | reset zoom / fit all |
| \ | collapse the palette |
| Ctrl+V | paste an image from the clipboard and slice it |

## Paste and slice

`Ctrl+V` with an image on the clipboard — a screenshot, a sprite sheet, an icon
grid — opens the slicer. Cut the image up, choose which pieces you want, and
`Import` writes those pieces into the served folder as individual PNGs, where
they appear in the palette immediately.

| Input | Action |
|---|---|
| click the top or left ruler | add one vertical / horizontal cut |
| drag a cut | move it |
| double-click a cut, or drag it off the image | remove it |
| Cols / Rows + Split | cut into an even grid |
| click a slice | include or exclude it |
| drag across slices | paint the same include/exclude over a run |
| All / None / Invert | bulk selection |
| Esc | close without importing |

Names come from the `Prefix` box: one slice is `prefix.png`, a grid is
`prefix-r2c3.png`, and any individual name can be overridden in the list on the
right. `Resize to` exports every slice at a fixed size instead of its natural
one — useful when a sheet's cells are a pixel or two apart.

An existing file is never overwritten: a colliding name is written as
`name-2.png`, and the status bar says how many were renamed.

The toolbar's `Paste image…` button does the same thing via the async clipboard
API, which the browser may refuse; `Ctrl+V` always works.

Groups are unnamed and atomic: clicking any member selects and moves the whole
group, keeping relative offsets exact. A dashed outline shows the group while
you hover or select it. To change an offset inside a group, ungroup, move,
regroup. Duplicating a group produces a new, independent group.

Saving is explicit — `Ctrl+S`. The status bar shows unsaved changes and the
browser warns before you close with work pending.

## WSL

Verified working under WSL2 (NAT networking, 9p `/mnt/c` mounts):

- Run the server inside WSL and open the URL in your Windows browser — WSL's
  localhost forwarding carries `127.0.0.1` through, so the loopback-only bind
  still reaches Windows Chrome/Edge.
- Folders on the Windows filesystem work: `python3 serve.py /mnt/c/Users/you/icons`.
  Filenames with spaces, non-ASCII characters and uppercase extensions all load,
  and the layout file writes atomically onto `/mnt/c`.
- Paste a Windows path and it is translated for you: `python3 serve.py 'C:\Users\you\icons'`
  reads `/mnt/c/Users/you/icons`. UNC paths (`\\wsl.localhost\...`) are rejected
  with a hint, since WSL cannot read them.
- Keeping icons on the Linux filesystem (`~/icons`) is noticeably faster than
  `/mnt/c`, which matters mainly on very large folders.
- If your Windows browser cannot reach the URL, localhost forwarding is off or
  broken — open the page from inside WSL, or check `localhostForwarding` in
  `%UserProfile%\.wslconfig`.

Run `./wsl-check.sh` to verify all of the above on your machine.

## Folder changes

The folder is read once when the page loads; reload to pick up changes.
A new file appears in the palette. A deleted file leaves its board instances in
place as dashed placeholders, so restoring the file restores the composition
exactly. Imported slices are the exception: they appear in the palette as soon
as the import finishes, without a reload.

## Layout

- `serve.py` — the whole server, ~300 lines, stdlib only
- `public/index.html`, `style.css` — shell and theme
- `public/app.js` — state, rendering, groups, undo, persistence, shortcuts
- `public/drag.js` — pointer interactions: drag, marquee, pan, zoom, palette
- `public/slice.js` — the clipboard slicer: guides, slice picking, import
- `public/selftest.html` — browser test suite (40 assertions)
- `public/wslcheck.html` — image-loading probe used by the WSL check
- `smoke.sh` — boots the server, probes HTTP, runs the suite headless
- `wsl-check.sh` — WSL-specific checks against a folder on the Windows filesystem
- `SPEC.md` / `CONTRACT.md` — behavior spec and the module contract
- `WINDOWS.md` — native Windows setup, start to finish

## Test

```sh
./smoke.sh
```

Checks the HTTP surface (including path-traversal rejection and the import
route's filename and content validation), then drives the
real UI with synthetic pointer events in headless Chrome: group drags preserving
relative offsets, delta snapping, duplication independence, marquee, undo/redo,
palette spawn and cancel, save round-trip, zoom clamping, and the full slicer
round-trip (cutting, slice picking, naming, import, no-overwrite). Set `CHROME=` if
the browser isn't found automatically.
