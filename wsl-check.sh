#!/usr/bin/env bash
# WSL-specific checks: serve a folder that lives on the Windows filesystem
# (/mnt/<drive>/...), with filenames that stress the 9p/DrvFs translation layer,
# and confirm both the HTTP surface and a real Windows browser can read it.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-5301}"
WIN_TMP="${WIN_TMP:-/mnt/c/Temp/imgnote-wslcheck}"

grep -qi microsoft /proc/version || { echo "not running under WSL — nothing to check"; exit 0; }
[ -d /mnt/c ] || { echo "no /mnt/c mount found — skipping Windows-filesystem checks"; exit 0; }

CHROME="${CHROME:-}"
if [ -z "$CHROME" ]; then
  for c in "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" \
           "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"; do
    [ -x "$c" ] && CHROME="$c" && break
  done
fi

rm -rf "$WIN_TMP"; mkdir -p "$WIN_TMP" || { echo "cannot write to $WIN_TMP"; exit 1; }
cp "$DIR/icons/sun.png"          "$WIN_TMP/sun.png"
cp "$DIR/icons/gear.png"         "$WIN_TMP/my icon with spaces.png"
cp "$DIR/icons/star.png"         "$WIN_TMP/ünïcodé-café-☂.png"
cp "$DIR/icons/play.png"         "$WIN_TMP/UPPERCASE.PNG"
cp "$DIR/icons/vector-arrow.svg" "$WIN_TMP/vector arrow.svg"
cp "$DIR/icons/README.txt"       "$WIN_TMP/notes.txt"

echo "== filesystem =="
printf '  %-22s %s\n' "path" "$WIN_TMP"
printf '  %-22s %s\n' "type" "$(stat -f -c %T "$WIN_TMP")"

python3 "$DIR/serve.py" "$WIN_TMP" --port "$PORT" >/tmp/imgnote-wsl.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$WIN_TMP"' EXIT
for _ in $(seq 1 60); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/files" && break; sleep 0.25; done

echo "== listing (want 5 images; notes.txt excluded) =="
curl -s "http://127.0.0.1:$PORT/files" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("  count:", len(d["files"]), "OK" if len(d["files"])==5 else "MISMATCH")
for f in d["files"]: print("   ", f["name"])'

echo "== byte-exact fetch of every name =="
curl -s "http://127.0.0.1:$PORT/files" | PORT="$PORT" python3 -c '
import json, os, sys, urllib.parse, urllib.request
port = os.environ["PORT"]
bad = 0
for f in json.load(sys.stdin)["files"]:
    url = "http://127.0.0.1:" + port + "/img/" + urllib.parse.quote(f["name"], safe="")
    try:
        r = urllib.request.urlopen(url, timeout=10)
        ok = r.status == 200 and len(r.read()) == f["size"]
    except Exception:
        ok = False
    bad += 0 if ok else 1
    print("  " + ("OK " if ok else "BAD") + "  " + f["name"])
sys.exit(1 if bad else 0)' || exit 1

echo "== layout write to the Windows filesystem =="
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"version":1,"grid":32,"items":[{"id":"i1","src":"my icon with spaces.png","x":64,"y":32,"group":null}],"groups":[]}' \
  "http://127.0.0.1:$PORT/layout"
echo "  round-trip: $(curl -s "http://127.0.0.1:$PORT/files" | python3 -c 'import json,sys; l=json.load(sys.stdin)["layout"]; print("OK" if l and l["items"][0]["src"]=="my icon with spaces.png" else "FAILED")')"

echo "== Windows-style path argument =="
python3 "$DIR/serve.py" 'C:\Temp\does-not-exist-imgnote' 2>&1 | sed 's/^/  /' | head -2

if [ -z "$CHROME" ]; then
  echo "== browser check: SKIPPED (no Windows Chrome/Edge found) =="
  exit 0
fi
echo "== Windows browser reaching the WSL server =="
timeout 90 "$CHROME" --headless --disable-gpu --no-sandbox --virtual-time-budget=30000 \
  --user-data-dir="C:\\Temp\\imgnote-wslcheck-profile" \
  --dump-dom "http://127.0.0.1:$PORT/wslcheck.html" 2>/dev/null | python3 -c '
import html,re,sys
d=sys.stdin.read(); m=re.search(r"<pre id=\"r\">(.*?)</pre>",d,re.S)
if not m: print("  page did not load — check WSL localhost forwarding"); sys.exit(1)
t=html.unescape(m.group(1))
for l in t.splitlines(): print("  "+l)
sys.exit(1 if "FAIL" in t else 0)'
