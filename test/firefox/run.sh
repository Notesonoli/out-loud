#!/bin/sh
# Firefox end to end: runs the real Firefox build (plus selftest.js, which opens
# test/page.html, starts the reader with a natural voice and reports what the
# player shows) using Mozilla's web-ext. Needs a sound device (e.g. PulseAudio
# null sink) and a Firefox binary in $FIREFOX. Reports print to the terminal.
set -e
cd "$(dirname "$0")/../.."
node build.mjs >/dev/null
rm -rf /tmp/ffst && cp -r dist/firefox /tmp/ffst
python3 - <<'PY'
import json, pathlib
E = pathlib.Path("/tmp/ffst")
m = json.loads((E/"manifest.json").read_text()); m["host_permissions"] = ["http://localhost/*"]
(E/"manifest.json").write_text(json.dumps(m))
(E/"background.html").write_text((E/"background.html").read_text() + '<script type="module" src="selftest.js"></script>\n')
PY
cp test/firefox/selftest.js /tmp/ffst/
(cd test && python3 -m http.server 8774 >/dev/null 2>&1) & WEB=$!
python3 test/firefox/report_server.py & REP=$!
timeout 420 npx web-ext run -s /tmp/ffst --firefox="${FIREFOX:-firefox}" ${FF_PROFILE:+--firefox-profile=$FF_PROFILE} --args="-headless" --no-reload >/dev/null 2>&1 || true
kill $WEB $REP 2>/dev/null || true
