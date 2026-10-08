import assert from "node:assert/strict"
import { readFileSync, rmSync, existsSync } from "node:fs"
import plugin from "../plugins/toolcall-guard.js"

const { LIVE, checkLiveness, makeGuard } = plugin.__test
const LOG = "/tmp/toolcall-guard-liveness.test.log"
process.env.TOOLCALL_GUARD_LIVENESS_LOG = LOG
const reset = () => Object.assign(LIVE, { requests: 0, chatReq: 0, streams: 0, warned: false })
try { rmSync(LOG) } catch {}

// wrapped guard + N model calls with zero interceptions => one loud warning
{
  reset()
  LIVE.wrapped = 2
  LIVE.requests = 24
  checkLiveness()
  assert.equal(existsSync(LOG), false, "must not warn below threshold")
  LIVE.requests = 25
  checkLiveness()
  assert.ok(existsSync(LOG), "must warn at threshold")
  const rows = readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, "guard-liveness")
  assert.ok(rows[0].err.includes("zero SSE streams intercepted"))
  assert.equal(rows[0].wrapped, 2)
  assert.equal(rows[0].requests, 25)
  LIVE.requests = 40
  checkLiveness()
  assert.equal(readFileSync(LOG, "utf8").trim().split("\n").length, 1, "warn once per process")
}

// unwrapped providers (native-only session) => never warn
{
  reset()
  try { rmSync(LOG) } catch {}
  LIVE.wrapped = 0
  LIVE.requests = 100
  checkLiveness()
  assert.equal(existsSync(LOG), false)
}

// guard actually intercepting => silent
{
  reset()
  LIVE.wrapped = 1
  LIVE.requests = 100
  LIVE.streams = 1
  checkLiveness()
  assert.equal(existsSync(LOG), false)
}

// makeGuard increments counters on a real SSE response and streams pass through
{
  reset()
  const sse = 'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
  const baseFetch = async () =>
    new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
  const guarded = makeGuard(baseFetch)
  const res = await guarded("https://api.example.com/v1/chat/completions", {})
  const text = await res.text()
  assert.equal(LIVE.chatReq, 1)
  assert.equal(LIVE.streams, 1)
  assert.ok(text.includes('"content":"hi"'), "well-formed stream passes through")
  checkLiveness()
  assert.equal(existsSync(LOG), false)
}
try { rmSync(LOG) } catch {}
console.log("liveness: ok")
