import assert from "node:assert/strict"
import plugin from "../plugins/toolcall-guard.js"

const { makeGuard } = plugin.__test

const ev = (o) => `data: ${JSON.stringify(o)}\n\n`
const DONE = "data: [DONE]\n\n"

function chunkIt(text, size) {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size))
      c.close()
    },
  })
}

async function run(sseText, opts = {}) {
  const { chunkSize = 1 << 20, contentType = "text/event-stream" } = opts
  const base = async () =>
    new Response(chunkIt(sseText, chunkSize), { status: 200, headers: { "content-type": contentType } })
  const res = await makeGuard(base)("https://x.test/v1/chat/completions", {})
  return res.text()
}

const events = (raw) =>
  raw
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((p) => p && p !== "[DONE]")
    .map((p) => JSON.parse(p))

const tcs = (raw) => {
  const out = []
  for (const e of events(raw))
    for (const c of e.choices || []) for (const t of (c.delta && c.delta.tool_calls) || []) out.push(t)
  return out
}

const OPEN_OK = { index: 0, id: "c1", function: { name: "read", arguments: "" } }
const CONT = { index: 0, function: { name: null, arguments: '{"p":1}' } }

// 1. well-formed stream passes through byte-identical
{
  const src =
    ev({ choices: [{ index: 0, delta: { tool_calls: [OPEN_OK] } }] }) +
    ev({ choices: [{ index: 0, delta: { tool_calls: [CONT] } }] }) +
    ev({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
    DONE
  const out = await run(src)
  assert.equal(out, src, "well-formed stream must be byte-identical")
}

// 2. name arrives late -> buffered, single valid opening with merged args
{
  const src =
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: null, arguments: '{"a"' } }] } }] }) +
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] }) +
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "calc" } }] } }] }) +
    ev({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
    DONE
  const list = tcs(await run(src))
  assert.equal(list.length, 1)
  assert.equal(list[0].id, "c1")
  assert.equal(list[0].function.name, "calc")
  assert.equal(list[0].function.arguments, '{"a":1}')
}

// 3. backtick-wrapped name is cleaned
{
  const src =
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "`read`", arguments: "" } }] } }] }) + DONE
  const list = tcs(await run(src))
  assert.equal(list[0].function.name, "read")
}

// 4. never-resolving call is dropped; text + finish survive (no throw)
{
  const src =
    ev({ choices: [{ index: 0, delta: { content: "hello" } }] }) +
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: null, arguments: '{"x"' } }] } }] }) +
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] } }] }) +
    ev({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    DONE
  const out = await run(src)
  assert.equal(tcs(out).length, 0)
  const texts = events(out).flatMap((e) => (e.choices || []).map((c) => c.delta && c.delta.content).filter((x) => x != null))
  assert.deepEqual(texts, ["hello"])
}

// 5. numeric id coerced to string
{
  const src =
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 42, function: { name: "read", arguments: "{}" } }] } }] }) + DONE
  const list = tcs(await run(src))
  assert.equal(list[0].id, "42")
}

// 6. same as fixture 2 but delivered in 3-byte chunks
{
  const src =
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: null, arguments: '{"a"' } }] } }] }) +
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] }) +
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "calc" } }] } }] }) +
    ev({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
    DONE
  const list = tcs(await run(src, { chunkSize: 3 }))
  assert.equal(list.length, 1)
  assert.equal(list[0].function.name, "calc")
  assert.equal(list[0].function.arguments, '{"a":1}')
}

// 7. reasoning text survives alongside a dropped phantom call (no id at all)
{
  const src =
    ev({ choices: [{ index: 0, delta: { reasoning_content: "call `read`" } }] }) +
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: null, arguments: "" } }] } }] }) +
    ev({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    DONE
  const out = await run(src)
  const rs = events(out).flatMap((e) => (e.choices || []).map((c) => c.delta && c.delta.reasoning_content).filter((x) => x != null))
  assert.deepEqual(rs, ["call `read`"])
  assert.equal(tcs(out).length, 0)
}

// 8. non-SSE response untouched
{
  const out = await run('{"ok":1}', { contentType: "application/json" })
  assert.equal(out, '{"ok":1}')
}

// 9. parallel calls: healthy index streams on, broken index resolves late
{
  const src =
    ev({ choices: [{ index: 0, delta: { tool_calls: [OPEN_OK, { index: 1, id: "b", function: { name: null, arguments: "" } }] } }] }) +
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"f":1}' } }, { index: 1, function: { arguments: '{"f":2}' } }] } }] }) +
    ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { name: "grep" } }] } }] }) +
    ev({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
    DONE
  const list = tcs(await run(src))
  const a = list.find((t) => t.id === "c1")
  const b = list.find((t) => t.id === "b")
  assert.ok(a && b)
  assert.equal(b.function.name, "grep")
  assert.equal(b.function.arguments, '{"f":2}')
  assert.equal(list.filter((t) => t.id === "c1" && t.function && t.function.name).length, 1)
}

// 10. complete tool call + finish_reason in one chunk passes through
{
  const src =
    ev({
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"p":1}' } }] }, finish_reason: "tool_calls" },
      ],
    }) + DONE
  const list = tcs(await run(src))
  assert.equal(list.length, 1)
  assert.equal(list[0].function.name, "read")
}

// --- outbound scrubber (context-poisoning defense) ---
const { scrub, scrubHistory } = plugin.__test
const TOK = "<" + "|" + "im_end" + "|" + ">"

// 11. scrub breaks the exact token, idempotent, leaves other text alone
{
  const poisoned = "see " + TOK + " here"
  const once = scrub(poisoned)
  assert.ok(!once.includes(TOK), "raw token must be gone")
  assert.ok(once.includes("im_end"), "name preserved")
  assert.equal(scrub(once), once, "idempotent")
  assert.equal(scrub("no tokens `here` <|"), "no tokens `here` <|", "partial sequences untouched")
}

// 12. scrubHistory walks text/reasoning/tool-state parts
{
  const msgs = [
    {
      info: { role: "assistant" },
      parts: [
        { type: "reasoning", text: "r " + TOK },
        { type: "text", text: "t " + TOK },
        { type: "tool", tool: "bash", state: { input: { command: "echo " + TOK } } },
      ],
    },
  ]
  const stats = { n: 0 }
  scrubHistory(msgs, stats)
  assert.equal(stats.n, 3)
  assert.ok(!JSON.stringify(msgs).includes(TOK))
}

// --- clipped-turn detector ---
const { clipKind, analyzeMessages } = plugin.__test

// 13. clipKind signatures
{
  assert.equal(clipKind(""), "empty")
  assert.equal(clipKind("   "), "empty")
  assert.equal(clipKind("ends mid-code `"), "dangling-backtick")
  assert.equal(clipKind("a `b` c `"), "dangling-backtick")
  assert.equal(clipKind("normal sentence."), null)
  assert.equal(clipKind("closed `code`"), null)
  assert.equal(clipKind("odd but not at end `x"), null)
}

// 14. analyzeMessages: fires only on clean-stop + no-tool + clipped-text
{
  const A = (parts, info) => [{ info: { role: "user", id: "u1" }, parts: [] }, { info: { role: "assistant", id: "a1", agent: "build", modelID: "m", providerID: "p", ...info }, parts }]
  const clip = [{ type: "text", text: "plan step one `" }, { type: "step-finish" }]
  assert.equal(analyzeMessages(A(clip)).kind, "dangling-backtick")
  assert.equal(analyzeMessages(A([{ type: "text", text: "" }, { type: "step-finish" }])).kind, "empty")
  assert.equal(analyzeMessages(A([{ type: "text", text: "all done." }, { type: "step-finish" }]))  , null)
  assert.equal(analyzeMessages(A([{ type: "text", text: "plan step one `" }])), null, "aborted stream: no step-finish, never nudged")
  assert.equal(analyzeMessages(A([...clip, { type: "tool", tool: "bash" }]))?.kind ?? null, null)
  assert.equal(analyzeMessages(A(clip, { error: { name: "Aborted" } })), null)
  assert.equal(analyzeMessages(A(clip, { agent: "title" })), null)
}

console.log("toolcall-guard: 14/14 fixtures pass")
