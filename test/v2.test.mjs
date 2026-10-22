import { mkdirSync as _mk } from "node:fs"
process.env.XDG_DATA_HOME = "/tmp/tcg-test-home"; _mk(process.env.XDG_DATA_HOME + "/opencode", { recursive: true }) // hermetic: never leak markers into a real data dir
// V2 adapter unit tests: entry shape, analyzeMessagesV2 (V2 message shape +
// {data} envelope), guardSseResponse interception, deep scrub on V2 parts.
import assert from "node:assert/strict"
process.env.TOOLCALL_GUARD = "off" // pure-function tests; no lanes, no files
const { default: plugin } = await import("../plugins/toolcall-guard.js")

const { analyzeMessagesV2, guardSseResponse, scrubStrings } = plugin.__test

// --- entry shape -----------------------------------------------------------
assert.equal(plugin.id, "toolcall-guard")
assert.equal(typeof plugin.setup, "function", "V2 setup attached to the V1 function core")
assert.equal(typeof plugin, "function", "V1 default export stays a callable function")
{
  const { default: v2entry } = await import("../plugin-v2/index.js")
  assert.equal(typeof v2entry, "object", "V2 package entry is an object")
  assert.equal(v2entry.id, "toolcall-guard")
  assert.equal(typeof v2entry.setup, "function")
}
{
  const hooks = await plugin({ client: null })
  for (const k of ["event", "tool.execute.before", "tool.execute.after", "experimental.chat.messages.transform", "config"])
    assert.equal(typeof hooks[k], "function", `V1 hook ${k} preserved`)
}
process.env.TOOLCALL_GUARD = "off"

// --- analyzeMessagesV2 -----------------------------------------------------
const asst = (over = {}, content = []) => ({ type: "assistant", id: "m1", agent: "build", finish: "stop", content, ...over })

// clip: clean stop, no tool, dangling backtick tail
{
  const a = analyzeMessagesV2([asst({}, [{ type: "text", text: "plan: first open the `" }])])
  assert.ok(a && a.kind === "dangling-backtick" && a.messageID === "m1")
}
// clip: empty visible text
assert.equal(analyzeMessagesV2([asst({}, [{ type: "reasoning", text: "thinking" }])]).kind, "empty")
// not a clip: balanced text
assert.equal(analyzeMessagesV2([asst({}, [{ type: "text", text: "all done `code` ok" }])]), null)
// not a clip: tool call present
assert.equal(analyzeMessagesV2([asst({}, [{ type: "text", text: "x `" }, { type: "tool", name: "shell" }])]), null)
// not a clip: no finish (aborted mid-stream — race-free skip)
assert.equal(analyzeMessagesV2([asst({ finish: undefined }, [{ type: "text", text: "x `" }])]), null)
// not a clip: errored turn
assert.equal(analyzeMessagesV2([asst({ error: { message: "boom" } }, [{ type: "text", text: "x `" }])]), null)
// auxiliary agents skipped
assert.equal(analyzeMessagesV2([asst({ agent: "title" }, [{ type: "text", text: "x `" }])]), null)
// last assistant wins; user messages ignored
{
  const msgs = [asst({ id: "old" }, [{ type: "text", text: "a" }]), { type: "user", text: "u" }, asst({ id: "new" }, [{ type: "text", text: "cut `" }])]
  assert.equal(analyzeMessagesV2(msgs).messageID, "new")
}
// {data:[...]} envelope unwrapped (ctx.session.context answer shape)
assert.ok(analyzeMessagesV2({ data: [asst({}, [{ type: "text", text: "cut `" }])] }))
// empty/garbage inputs never throw
assert.equal(analyzeMessagesV2(undefined), null)
assert.equal(analyzeMessagesV2([]), null)

// --- guardSseResponse ------------------------------------------------------
const te = new TextEncoder()
const sseBody = (lines) => new Response(new Blob(lines.map((l) => te.encode(l))), { headers: { "content-type": "text/event-stream" } })

// null-name opening + late name merges into one valid opening fragment
{
  const chunk = (delta, finish) => "data: " + JSON.stringify({ choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] }) + "\n\n"
  const res = sseBody([
    chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: null, arguments: '{"a":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { name: "shell" } }] }),
    chunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ])
  const { res: out, guarded } = guardSseResponse(res)
  assert.ok(guarded, "SSE response is intercepted")
  const text = await out.text()
  const opens = text.split("\n").filter((l) => l.includes('"name":"shell"'))
  assert.equal(opens.length, 1, "exactly one opening fragment carries the name")
  assert.ok(opens[0].includes('"id":"c1"') && opens[0].includes('\\"a\\":1}'), "id + merged args ride the opening fragment")
  assert.ok(!text.includes('"name":null'), "no null-name delta survives")
}
// never-resolving phantom dropped at finish_reason
{
  const chunk = (delta, finish) => "data: " + JSON.stringify({ choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] }) + "\n\n"
  const res = sseBody([
    chunk({ content: "hi " }),
    chunk({ tool_calls: [{ index: 0, id: "gx", function: { name: null, arguments: "{}" } }] }),
    chunk({}, "stop"),
    "data: [DONE]\n\n",
  ])
  const text = await guardSseResponse(res).res.text()
  assert.ok(!text.includes("gx"), "phantom call id dropped")
  assert.ok(!text.includes('"name"'), "no name survives the phantom")
  assert.ok(text.includes("hi "), "text survives")
}
// non-SSE passes through untouched
{
  const res = new Response(new Blob([te.encode('{"ok":true}')]), { headers: { "content-type": "application/json" } })
  const { res: out, guarded } = guardSseResponse(res)
  assert.equal(out, res)
  assert.equal(guarded, false)
}
// error responses pass through
{
  const res = new Response(new Blob([te.encode("boom")]), { status: 500, headers: { "content-type": "text/event-stream" } })
  assert.equal(guardSseResponse(res).guarded, false)
}

// --- deep scrub on V2 message shapes ---------------------------------------
{
  const POISON = "<" + "|" + "im_end" + "|" + ">"
  const msgs = [{ type: "assistant", content: [{ type: "reasoning", text: "see " + POISON }, { type: "tool", name: "shell", state: { status: "completed", input: { command: "grep " + POISON + " f" }, metadata: {} } }] }]
  const stats = { n: 0 }
  scrubStrings(msgs, stats)
  assert.equal(stats.n, 2, "reasoning + tool-args both scrubbed")
  const blob = JSON.stringify(msgs)
  assert.ok(!blob.includes(POISON), "raw token gone")
  assert.ok(blob.includes("< |im_end| >"), "spaced form present")
  const again = { n: 0 }
  scrubStrings(msgs, again)
  assert.equal(again.n, 0, "idempotent")
}

console.log("v2.test.mjs: all assertions passed")
