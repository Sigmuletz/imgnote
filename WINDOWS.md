# Running imgnote on Windows

Start to finish: install Python, get the code, run the server, open the board.
No WSL, no build step, no `pip install` — imgnote uses only the Python standard
library and plain JavaScript.

Verified on Windows 11 with Python 3.14 and Chrome: all 69 assertions in the
browser test suite pass against a natively-hosted server.

**Time:** about ten minutes, most of it the Python installer.

---

## 1. Install Python

You need Python **3.12 or newer**. Pick one of the two options below.

### Option A — the official installer (recommended)

1. Go to <https://www.python.org/downloads/windows/> and download the latest
   **Windows installer (64-bit)**.
2. Run it. On the very first screen, **tick "Add python.exe to PATH"** at the
   bottom before clicking anything else. This is the single most common thing
   people miss, and skipping it is what causes "python is not recognized"
   later.
3. Leave "Install launcher for all users" ticked — that gives you the `py`
   command used throughout this guide.
4. Click **Install Now** and wait for it to finish.

### Option B — winget (one line, if you prefer the terminal)

Open **PowerShell** and run:

```powershell
winget install Python.Python.3.13
```

Close and reopen PowerShell afterwards so the new PATH takes effect.

### Check it worked

Open a **new** PowerShell window (Start menu → type `powershell` → Enter) and
run:

```powershell
py --version
```

You should see something like `Python 3.13.1`. If you do, move on to step 2.

> **"Python was not found; run without arguments to install from the Microsoft
> Store"**
> Windows ships placeholder `python.exe` stubs that redirect to the Store and
> shadow a real install. Fix: **Settings → Apps → Advanced app settings → App
> execution aliases**, then switch **off** the entries named `python.exe` and
> `python3.exe`. Reopen PowerShell and try again.
>
> **"py is not recognized"**
> The launcher was not installed. Re-run the installer, choose **Modify**, and
> make sure "py launcher" is ticked. Or just use `python` instead of `py` in
> every command below.

---

## 2. Get the code

### Option A — clone with Git

1. Install Git for Windows if you do not have it:

   ```powershell
   winget install Git.Git
   ```

   Then close and reopen PowerShell.

2. Choose where the code should live and clone it:

   ```powershell
   cd $HOME\Documents
   git clone <REPOSITORY-URL> imgnote
   cd imgnote
   ```

   Replace `<REPOSITORY-URL>` with the actual repo address, for example
   `https://github.com/yourname/imgnote.git`.

> **Note:** this project is not in a Git repository yet, so there is no URL to
> clone from until someone pushes it. See
> [Appendix: putting it in a repo](#appendix-putting-it-in-a-repo) if that is
> you. Until then, use Option B or just copy the folder across.

### Option B — download a ZIP

1. On the repository page (GitHub, GitLab, …), click the green **Code** button
   and choose **Download ZIP**.
2. Find the file in your **Downloads** folder. Right-click it → **Properties**.
   If there is an **Unblock** checkbox near the bottom, tick it and click OK —
   Windows flags downloaded archives, and unblocking avoids warnings later.
3. Right-click the ZIP → **Extract All…** → pick a destination such as
   `C:\Users\<you>\Documents` → **Extract**.
4. You will end up with a folder like `imgnote-main`. Open PowerShell there:
   in File Explorer, hold **Shift**, right-click empty space inside the folder,
   and choose **Open PowerShell window here** (or **Open in Terminal**).

### Check you are in the right place

```powershell
dir
```

You should see `serve.py`, `README.md`, and the folders `public`, `icons` and
`puzzle`. If you see a single subfolder instead, `cd` into it and look again —
ZIP extraction often adds one extra level.

---

## 3. Run it

From the folder containing `serve.py`:

```powershell
py serve.py .\icons
```

You should see:

```
imgnote
  folder: C:\Users\you\Documents\imgnote\icons
  images: 15
  url:    http://127.0.0.1:5173/
  (Ctrl+C to stop)
```

Now open <http://127.0.0.1:5173> in Chrome, Edge or Firefox. The left palette
fills with the icons from the folder; drag one onto the canvas.

**To stop the server**, click back on the PowerShell window and press
**Ctrl+C**. Leave it running while you use the board — closing that window
closes the app.

### Pointing it at your own folder

The argument is whichever folder of images you want to work with:

```powershell
py serve.py C:\Users\you\Pictures\icons
py serve.py .\puzzle
```

Quote any path containing spaces:

```powershell
py serve.py "C:\Users\you\My Game Art\sprites"
```

Only the folder itself is read — subfolders are ignored, and the allowed
extensions are `.png .jpg .jpeg .gif .webp .svg .avif .bmp .ico`.

### If port 5173 is busy

```powershell
py serve.py .\icons --port 5174
```

Then open <http://127.0.0.1:5174> instead.

---

## 4. Optional: start it with a double-click

Typing the command each time gets old. Open Notepad, paste this, and save it
next to `serve.py` as **`imgnote.bat`** (in the Save dialog set "Save as type"
to **All Files**, or Notepad will make it `imgnote.bat.txt`):

```bat
@echo off
cd /d "%~dp0"
start "" http://127.0.0.1:5173/
py serve.py ".\icons"
pause
```

Double-clicking `imgnote.bat` now starts the server and opens your browser.
The console window stays open; close it or press Ctrl+C to stop.

To point it at a different folder, change `".\icons"` to that path. You can
keep several `.bat` files, one per project folder.

---

## 5. Paste and slice on Windows

The clipboard import works the same as everywhere else:

1. Copy an image — **Win+Shift+S** for a screen snip, or copy a sprite sheet
   from any app.
2. Click once on the imgnote page so it has focus, then press **Ctrl+V**.
3. The slicer opens. Set **Cols** and **Rows** and click **Split**, or click
   the rulers to place cuts by hand.
4. Click any slice to exclude it, then click **Import**.

The pieces are written as PNGs into the folder you started the server with, and
appear in the palette straight away.

**Windows filenames are case-insensitive**, which matters here: `cat.png` and
`CAT.png` are the same file as far as Windows is concerned. imgnote never
overwrites an existing image, so importing `CAT.png` into a folder that already
has `cat.png` writes `CAT-2.png`. The status bar tells you how many were
renamed.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `python is not recognized` | PATH was not set during install. Use `py` instead, or re-run the installer and tick "Add python.exe to PATH". |
| "Python was not found… Microsoft Store" | Store alias stubs. Settings → Apps → Advanced app settings → App execution aliases → turn off `python.exe` and `python3.exe`. |
| `py is not recognized` | The launcher was not installed. Use `python` instead, or re-run the installer with "py launcher" ticked. |
| `error: folder does not exist` | The path after `serve.py` is wrong. Run `dir` to check what is actually there; quote paths with spaces. |
| `error: port 5173 is already in use` | Something else has the port, possibly an imgnote you forgot to stop. Add `--port 5174`. |
| Windows Defender Firewall prompt | imgnote binds `127.0.0.1` only, so it never needs network access. **Cancel** the prompt — the app still works. |
| Browser says "can't connect" | The server is not running, or you typed the wrong port. Check the PowerShell window for the banner, and use exactly the URL it prints. |
| Page loads but the palette is empty | The folder has no files with an allowed extension, or they are in subfolders. Subfolders are not scanned. |
| An icon shows as a dashed box | That file is gone from disk. The board keeps the placeholder so restoring the file restores the layout. |
| Ctrl+V does nothing | Click on the page first so it has focus, and make sure you copied an *image*, not a file from Explorer. The toolbar's "Paste image…" button may also be blocked by the browser's clipboard permission — Ctrl+V always works. |
| Images load very slowly | If the folder is inside OneDrive, the files may be cloud placeholders that download on first read. Right-click the folder → **Always keep on this device**. |
| Changes to the folder do not show up | The folder is read once when the page loads. Refresh the browser (F5). Imported slices are the exception — they appear immediately. |

---

## Running the tests on Windows

`smoke.sh` is a bash script and expects Linux or WSL; it will not run in
PowerShell. The part that matters most — the 69-assertion browser suite — runs
fine on Windows:

1. Start the server against a **scratch copy** of a folder, not one you care
   about (the suite writes real files):

   ```powershell
   py serve.py .\icons
   ```

2. Open <http://127.0.0.1:5173/selftest.html>.
3. The page prints its results and finishes with a line like `69 passed,
   0 failed`.
4. The suite leaves test files behind. Clean up afterwards:

   ```powershell
   del .\icons\zzslicetest*.png
   del .\icons\.imgnote.json
   ```

---

## What gets written to disk

Worth knowing before you point imgnote at a folder you care about:

- **Existing image files are never modified or deleted.** Nothing in the app
  edits or removes them.
- A single `.imgnote.json` file is written inside the folder when you press
  **Ctrl+S**. That is your board layout, and it travels with the folder.
- Importing slices adds **new** image files to the folder. A name already in
  use gets a `-2` suffix rather than overwriting anything.

---

## Appendix: putting it in a repo

This project is not under version control yet. To publish it so the `git clone`
route above works, from the project folder:

```powershell
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/yourname/imgnote.git
git push -u origin main
```

Create the empty repository on GitHub first (without a README, so the push is
not rejected). You will be prompted to sign in on the first push; Git for
Windows handles this through its credential manager in a browser window.

Consider adding a `.gitignore` so board layouts and imported test files do not
get committed:

```gitignore
.imgnote.json
zzslicetest*.png
```
