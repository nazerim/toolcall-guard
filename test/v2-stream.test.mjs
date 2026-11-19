import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const dir = mkdtempSync(join(tmpdir(), "tcg-v2-stream-"))
process.on("exit", () => rmSync(dir, { recursive: true, force: true }))
process.env.TOOLCALL_GUARD_V2_DEBUG = "STREAM"
process.env.TOOLCALL_GUARD_DATA_DIR = dir
process.env.TOOLCALL_GUARD = "off"
const { default: plugin } = await import("../plugins/toolcall-guard.js")
let hook
await plugin.setup({
  session: { hook: async (k, cb) => { if (k === "http.response") hook = cb } },
  provider: { list: async () => [] },
})
const send = response => { const e = { response }; hook(e); return e.response }
const rows = name => readFileSync(join(dir, name), "utf8").trim().split("\n").map(JSON.parse.bind(JSON))
const json = Response.json({})
for (let i = 0; i < 30; i++) assert.equal(send(json), json)
assert.equal(existsSync(join(dir, "toolcall-guard.errors")), false)
assert.deepEqual(rows("toolcall-guard.stream-info").map(r => r.reason), ["non-sse"])
const bad = new Response(null, {status: 503})
send(bad); send(bad); send(undefined)
const sse = { headers: {"content-type": "text/event-stream"} }
send(new Response(null, sse))
const locked = new Response("data: ok\n\n", sse)
locked.body.getReader()
send(locked)
assert.deepEqual(rows("toolcall-guard.errors").map(r => r.reason),
  ["http-error", "invalid-response", "missing-sse-body", "wrap-failed"])
assert.equal(plugin.__test.LIVE.streams, 0)
const chunk = tc => "data: " + JSON.stringify({choices:[{delta:{tool_calls:[tc]}}]}) + "\n\n"
for (let i = 0; i < 2; i++) {
  const wire = chunk({index:0,id:"fixture",function:{name:null,arguments:"{"}}) +
    chunk({index:0,function:{name:"example",arguments:"}"}})
  const raw = new Response(wire, sse)
  const out = send(raw)
  assert.notEqual(out, raw)
  const frames = (await out.text()).trim().split("\n\n").map(s => JSON.parse(s.slice(6)))
  assert.deepEqual(frames[1].choices[0].delta.tool_calls[0].function, {name:"example",arguments:"{}"})
}
assert.equal(plugin.__test.LIVE.streams, 2)
assert.deepEqual(rows("toolcall-guard.stream-info").map(r => r.reason), ["non-sse","repaired"])
console.log("v2 stream diagnostics: ok")
