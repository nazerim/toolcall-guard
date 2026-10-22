#!/bin/zsh
# toolcall-guard V2 e2e matrix: late / drop / poison / clip against the
# synthetic SSE fixture (test/toolcall-guard-server.mjs), driven through a
# real opencode-2 standalone server with an isolated XDG triple.
#
# Requirements: opencode v2 at /opt/homebrew/opt/opencode-v2/bin/opencode,
# the v2 fixture config (test/toolcall-guard-test.v2.opencode.json), and
# plugin-v2/ pointing at the shared core. Pass criteria per scenario:
#   late   -> guard merges the null-name opening; tool runs; session ends
#   drop   -> phantom call dropped; visible text survives; session ends
#   poison -> reasoning token scrubbed before replay (spaced on the wire,
#             zero raw <|..|> tokens, toolcall-guard.scrubbed non-empty)
#   clip   -> clipped turn detected; session.idle nudge sent
#             (toolcall-guard.clips non-empty)
# Logs/markers land in the sandbox data dir only (never the real ones).
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
T=${TMPDIR:-/tmp}/tcg-e2e-v2
CFG=$REPO/test/toolcall-guard-test.v2.opencode.json
BIN=${OPENCODE_V2_BIN:-/opt/homebrew/opt/opencode-v2/bin/opencode}
export OPENCODE_DISABLE_AUTOUPDATE=1

# bare config dir: the v2 fixture config is layered via OPENCODE_CONFIG so
# the global enabled_providers policy cannot deny the guardtest provider
rm -rf $T && mkdir -p $T/config/opencode $T/data $T/cache

for SC in late drop poison clip; do
  rm -f $REPO/test/reqs.jsonl
  SCENARIO=$SC PORT=8787 GUARDTEST_REQS=$REPO/test/reqs.jsonl node $REPO/test/toolcall-guard-server.mjs > $T/server-$SC.log 2>&1 &
  SRV=$!
  sleep 0.8
  rm -rf $T/data && mkdir -p $T/data
  OUT=$(cd $REPO/test && XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_CACHE_HOME=$T/cache OPENCODE_CONFIG=$CFG $BIN run --standalone --auto -m guardtest/guardtest-model "say hi MARKER7788" 2>&1 | tail -2 | tr '\n' ' ')
  REQN=$(wc -l < $REPO/test/reqs.jsonl 2>/dev/null | tr -d ' ')
  SCRUB=$(cat $T/data/opencode/toolcall-guard.scrubbed 2>/dev/null | tail -1)
  CLIPF=$(cat $T/data/opencode/toolcall-guard.clips 2>/dev/null | tail -1)
  ERRS=$(cat $T/data/opencode/toolcall-guard.errors 2>/dev/null | tail -1)
  RAW=0; SPACED=0
  if [ -f $REPO/test/reqs.jsonl ]; then
    RAW=$(grep -o '<|' $REPO/test/reqs.jsonl | wc -l | tr -d ' ')
    SPACED=$(grep -o '< |' $REPO/test/reqs.jsonl | wc -l | tr -d ' ')
  fi
  echo "== $SC: out=[$OUT] reqs=$REQN rawTok=$RAW spacedTok=$SPACED"
  [ -f $T/data/opencode/toolcall-guard.loaded ] || echo "   NO MARKER — plugin not loaded this run"
  [ -n "$SCRUB" ] && echo "   scrubbed: $SCRUB"
  [ -n "$CLIPF" ] && echo "   clips:    $CLIPF"
  [ -n "$ERRS" ] && echo "   errors:   $ERRS"
  kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
done
echo done
