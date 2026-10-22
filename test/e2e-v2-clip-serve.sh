#!/bin/zsh
# toolcall-guard V2 auto-continue e2e (clip scenario) on a PERSISTENT server:
# a standalone `serve` hosts the guarded session (plugin loaded); the clipped
# turn ends clean -> the plugin's session.execution.succeeded subscriber must
# nudge -> continuation turn -> ALL_DONE. Proves the full nudge round-trip
# (the run --standalone matrix proves the same, but the nudge can race the
# CLI's exit).
#
# Pass: toolcall-guard.clips contains a dangling-backtick row; the fixture
# log shows a second request with nudged=true. Cleanup kills only the PIDs
# this script started — never pkill -f patterns that could hit the
# operator's own servers.
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
T=${TMPDIR:-/tmp}/tcg-e2e-v2-clip
CFG=$REPO/test/toolcall-guard-test.v2.opencode.json
BIN=${OPENCODE_V2_BIN:-/opt/homebrew/opt/opencode-v2/bin/opencode}
PW=tcg-local-test-pw
AUTH="opencode:$PW"
export OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_SERVER_PASSWORD=$PW
rm -rf $T && mkdir -p $T/config/opencode $T/data $T/cache $T/cwd

cleanup() { [ -n "${SRV:-}" ] && kill $SRV 2>/dev/null; [ -n "${SRV2:-}" ] && kill $SRV2 2>/dev/null; wait 2>/dev/null }
trap cleanup EXIT

rm -f $REPO/test/reqs.jsonl
SCENARIO=clip PORT=8787 GUARDTEST_VERBOSE=1 GUARDTEST_REQS=$REPO/test/reqs.jsonl node $REPO/test/toolcall-guard-server.mjs > $T/server.log 2>&1 &
SRV=$!
sleep 0.8
( cd $T/cwd && exec env XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_CACHE_HOME=$T/cache OPENCODE_CONFIG=$CFG $BIN serve --port 4096 > $T/serve.log 2>&1 ) &
SRV2=$!
# plugin + location boot is lazy: poll for the loaded marker (up to 30s)
for i in $(seq 1 30); do [ -f $T/data/opencode/toolcall-guard.loaded ] && break; curl -s -u "$AUTH" http://127.0.0.1:4096/api/model > /dev/null; sleep 1; done
echo "marker: $(cat $T/data/opencode/toolcall-guard.loaded 2>/dev/null || echo NEVER)"
SID=$(curl -s -u "$AUTH" -X POST http://127.0.0.1:4096/api/session -H 'content-type: application/json' -d '{"title":"tcg-loop","model":{"providerID":"guardtest","id":"guardtest-model"}}' | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("data") or d).get("id",""))')
echo "session: $SID"
[ -z "$SID" ] && { echo CREATE-FAILED; exit 1; }
curl -s -u "$AUTH" -X POST "http://127.0.0.1:4096/api/session/$SID/prompt" -H 'content-type: application/json' -d '{"text":"say hi MARKER7788"}' --max-time 30 | head -c 120
sleep 6
echo; echo "clips:  $(cat $T/data/opencode/toolcall-guard.clips 2>/dev/null | tail -1)"
echo "reqs:   $(wc -l < $REPO/test/reqs.jsonl 2>/dev/null | tr -d ' ')  (expect 2: primary + nudge continuation)"
grep -c 'nudged=true' $T/server.log | sed 's/^/fixture nudged-requests: /'
echo done
