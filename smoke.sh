#!/usr/bin/env bash
# End-to-end check: boots the server, probes the HTTP surface, then runs the
# in-browser self-test suite (public/selftest.html) in headless Chrome and
# prints its results. Requires a Chrome/Edge binary; on WSL it uses the
# Windows one.
set -u
PORT="${PORT:-5199}"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${TMPDIR:-/tmp}/imgnote-smoke"
mkdir -p "$OUT"

CHROME="${CHROME:-}"
if [ -z "$CHROME" ]; then
  for c in "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" \
           "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
           "$(command -v google-chrome || true)" "$(command -v chromium || true)"; do
    [ -x "$c" ] && CHROME="$c" && break
  done
fi

python3 "$DIR/serve.py" "$DIR/icons" --port "$PORT" >"$OUT/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for _ in $(seq 1 40); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/files" && break
  sleep 0.25
done

echo "== HTTP surface =="
printf '  %-30s %s\n' "GET /files images" \
  "$(curl -s "http://127.0.0.1:$PORT/files" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["files"]))')"
for p in "/" "/app.js" "/drag.js" "/slice.js" "/style.css" "/img/sun.png"; do
  printf '  %-30s %s\n' "GET $p" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$p")"
done
echo "== rejected (want 404) =="
for p in "/img/../serve.py" "/img/%2e%2e%2fserve.py" "/img/../../etc/passwd" "/img/README.txt" "/img/.hidden.png" "/nonsense"; do
  printf '  %-30s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$p")"
done

if [ -z "$CHROME" ]; then
  echo "== selftest: SKIPPED (no Chrome found; set CHROME=/path/to/chrome) =="
  exit 0
fi

echo "== selftest (headless browser) =="
rm -f "$DIR/icons/.imgnote.json"        # suite asserts an empty first-run board
rm -f "$DIR"/icons/zzslicetest*.png     # slicer suite imports real files; start clean
timeout 180 "$CHROME" --headless --disable-gpu --no-sandbox \
  --virtual-time-budget=150000 --window-size=1280,900 \
  --user-data-dir="C:\\Temp\\imgnote-smoke" \
  --dump-dom "http://127.0.0.1:$PORT/selftest.html" 2>/dev/null > "$OUT/selftest.html"
python3 - "$OUT/selftest.html" <<'PY'
import html, re, sys
d = open(sys.argv[1], encoding="utf-8", errors="replace").read()
m = re.search(r'<pre id="results">(.*?)</pre>', d, re.S)
if not m:
    print("  NO RESULTS — the page did not finish"); sys.exit(1)
lines = [l for l in html.unescape(m.group(1)).splitlines() if not l.startswith("..")]
for l in lines:
    if l.startswith("FAIL"):
        print("  " + l)
tally = [l for l in lines if "passed," in l]
print("  " + (tally[-1] if tally else "suite did not reach its summary"))
sys.exit(1 if (not tally or not tally[-1].endswith("0 failed")) else 0)
PY
rc=$?
rm -f "$DIR/icons/.imgnote.json"
rm -f "$DIR"/icons/zzslicetest*.png
exit $rc
