// Subagent coverage of the V2 stream guard, against a faithful simulation of
// the 2.3.2 dispatch (packages/core/src/plugin/hooks.ts register/trigger/has +
// packages/core/src/session/model-request.ts hasHttpHooks gating).
//
// RED shape (before plugin-v2/stream-report.js): the core guard still repairs
// the bytes, but nothing records that it ran — which is exactly how "the V2
// guard never intercepts SSE, not even in subagents" was concluded from
// toolcall-guard.stream-info. GREEN: every primary SSE stream, root or child,
// leaves sse-seen/response-replaced lines with its sessionID, and auxiliary
// (non-primary) JSON responses leave no line at all.
//
// Also pinned here (independent-review findings, 2026-11-20):
// - TOOLCALL_GUARD=off disables this LANE (privacy contract; the core stays).
// - the 12-line budget is shared across setups and counts WRITTEN LINES
//   (including macrotask verification writes), and exhausting it must not
//   affect the core guard's repair.
// - fatality is explicit ({ fatal: true }), decoupled from registration order.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = mkdtempSync(join(tmpdir(), "tcg-v2-subagent-"))
process.env.TOOLCALL_GUARD_DATA_DIR = root
delete process.env.TOOLCALL_GUARD
delete process.env.TOOLCALL_GUARD_V2_DEBUG
const { default: entry } = await import("../plugin-v2/index.js")
const { setupStreamReport } = await import("../plugin-v2/stream-report.js")
const { setupLanes } = await import("../plugin-v2/setup-lanes.js")

// --- minimal 2.3.2 runtime ------------------------------------------------
// hooks.ts:97 has() ignores providerID for unscoped entries; :88 trigger()
// walks registrations in order and returns the (possibly mutated) event.
const registry = new Map()
let seq = 0
const key = (name) => `session.${name}`
const register = (name, callback, options) => {
  const id = key(name)
  const item = { callback, options, seq: seq++ }
  registry.set(id, [...(registry.get(id) ?? []), item])
  return { dispose: () => registry.set(id, (registry.get(id) ?? []).filter((e) => e !== item)) }
}
const has = (name, providerID) =>
  (registry.get(key(name)) ?? []).some((e) => e.options?.providerID === undefined || e.options.providerID === providerID)
const trigger = async (name, event) => {
  for (const entry of registry.get(key(name)) ?? []) {
    if (entry.options?.providerID !== undefined && entry.options.providerID !== event.model?.providerID) continue
    await entry.callback(event)
  }
  return event
}

const subs = []
const ctx = {
  location: { directory: "/fixture" },
  provider: { list: async () => [] },
  session: {
    hook: (name, callback, options) => Promise.resolve(register(name, callback, options)),
    get: async () => ({}),
    context: async () => ({ data: [] }),
    prompt: async () => ({}),
  },
  event: {
    subscribe: (options) => {
      const signal = options && options.signal
      subs.push(signal)
      return {
        async *[Symbol.asyncIterator]() {
          if (!signal) return
          await new Promise((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true })))
        },
      }
    },
  },
}

const cleanup = await entry.setup(ctx)
const providerID = "qwen-subscription"
const sse = { "content-type": "text/event-stream" }
const chunk = (tc) => "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [tc] } }] }) + "\n\n"
// The provider's late-name shape: a new index opens with name:null, the real
// name arrives one frame later. The 2.x native handler buffers this, but only
// the guard can merge it into a single valid opening fragment.
const malformed = () =>
  chunk({ index: 0, id: "call_1", function: { name: null, arguments: "{" } }) +
  chunk({ index: 0, function: { name: "example", arguments: "}" } }) +
  "data: [DONE]\n\n"

// model-request.ts:375-405 — install the HTTP hook only when has() says so,
// then hand the parser the response the hooks settled on.
const request = async ({ sessionID, kind = "primary", body, status = 200, headers = sse }) => {
  const model = { providerID, id: "qwen3.8-flash" }
  const hasHttpHooks = has("http.request", providerID) || has("http.response", providerID)
  let response = new Response(body, { status, headers })
  if (hasHttpHooks) {
    const event = { sessionID, agent: "general", model, kind, request: {}, response }
    const after = await trigger("http.response", event)
    response = after.response
  }
  return { text: await response.text(), wrapped: hasHttpHooks }
}

const rows = () => {
  try {
    return readFileSync(join(root, "toolcall-guard.stream-info"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  } catch {
    return []
  }
}
const frames = (wire) =>
  wire.trim().split("\n\n").filter((s) => s.startsWith("data: ") && !s.includes("[DONE]"))
    .map((s) => JSON.parse(s.slice(6)))

try {
  const ROOT = "ses_0668d90effejNJeNfcDOd2puU"
  const CHILD = "ses_0669a10effejNJeNfcDOd2puU"
  assert.equal(has("http.response", providerID), true, "unscoped hook satisfies has() for any provider")

  const rootRun = await request({ sessionID: ROOT, body: malformed() })
  const childRun = await request({ sessionID: CHILD, body: malformed() })

  // Both sessions see the same repaired wire: the unresolvable opening frame is
  // emptied, then one valid opening fragment carries id+name and the merged
  // arguments (the 2.x handler would otherwise buffer it and fail at finish).
  for (const run of [rootRun, childRun]) {
    assert.equal(run.wrapped, true)
    const parsed = frames(run.text)
    assert.deepEqual(parsed[0].choices[0].delta.tool_calls, [])
    assert.deepEqual(parsed[1].choices[0].delta.tool_calls[0].id, "call_1")
    assert.deepEqual(parsed[1].choices[0].delta.tool_calls[0].function, { name: "example", arguments: "{}" })
    assert.equal(run.text.includes("[DONE]"), true)
  }

  // Auxiliary requests answer JSON and must not look like guard misses.
  await request({ sessionID: ROOT, kind: "title", body: JSON.stringify({ title: "x" }), headers: { "content-type": "application/json" } })
  await request({ sessionID: ROOT, kind: "generate", body: JSON.stringify({ ok: true }), headers: { "content-type": "application/json" } })

  await new Promise((resolve) => setTimeout(resolve, 10)) // let the 0 ms verification timers run
  const report = rows()
  const seen = report.filter((r) => r.reason === "sse-seen")
  assert.deepEqual(seen.map((r) => r.sessionID), [ROOT, CHILD], "sse-seen names the root AND the child session")
  const replaced = report.filter((r) => r.reason === "response-replaced").map((r) => r.sessionID)
  assert.deepEqual(replaced, [ROOT, CHILD], "a downstream hook replaced the body for both sessions")
  assert.deepEqual(report.filter((r) => r.reason === "non-sse-primary"), [], "JSON auxiliary calls are not misses")
  assert.equal(report.every((r) => r.lane === "v2-stream-report"), true)
  const { default: core } = await import("../plugins/toolcall-guard.js")
  assert.equal(core.__test.LIVE.streams, 2, "core guard wrapped exactly the two primary streams")

  // --- master switch: TOOLCALL_GUARD=off disables this LANE (core unaffected) --
  const hooksBefore = (registry.get(key("http.response")) ?? []).length
  process.env.TOOLCALL_GUARD = "off"
  try {
    assert.equal(await setupStreamReport(ctx, { DATA_DIR: () => root }), undefined, "off: lane registers nothing")
  } finally {
    delete process.env.TOOLCALL_GUARD
  }
  assert.equal((registry.get(key("http.response")) ?? []).length, hooksBefore, "off: no hook registered")

  // --- budget: 12 lines total, shared across setups, core unaffected ----------
  const budgetBefore = rows().length // 4 from the runs above
  assert.equal(budgetBefore, 4, "pre-budget report has the 2x(sse-seen+response-replaced) lines")
  const second = await setupStreamReport(ctx, { DATA_DIR: () => root }) // second setup, shared module budget
  try {
    let last
    for (let i = 0; i < 8; i++) last = await request({ sessionID: `ses_budget_${i}`, body: malformed() })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const capped = rows()
    assert.equal(capped.length, 12, "budget caps WRITTEN LINES at 12 across setups (not 12 responses)")
    assert.deepEqual(capped.map((r) => r.n), Array.from({ length: 12 }, (_, i) => i + 1), "n numbers every written line")
    const parsed = frames(last.text)
    assert.deepEqual(parsed[1].choices[0].delta.tool_calls[0].function, { name: "example", arguments: "{}" }, "core still repairs after the lane caps out")
  } finally {
    if (second) await second()
  }
} finally {
  await cleanup()
  rmSync(root, { recursive: true, force: true })
}

// --- fatality is explicit, decoupled from registration order -----------------
const readErrors = () => {
  try {
    return readFileSync(join(errRoot, "toolcall-guard.errors"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  } catch {
    return []
  }
}
const errRoot = mkdtempSync(join(tmpdir(), "tcg-v2-fatal-"))
const helpers = { DATA_DIR: () => errRoot }
try {
  // An optional lane FIRST may throw without killing setup; the declared-fatal
  // core after it still runs (this is the exact entry composition).
  let coreRan = false
  const dispose = await setupLanes({}, helpers, [
    function flakyObserver() { throw new TypeError("observer boom") },
    { setup: function core() { coreRan = true; return () => {} }, fatal: true },
  ])
  assert.equal(coreRan, true, "fatal core still set up after an optional-lane failure")
  const logged = readErrors()
  assert.equal(logged.at(-1)?.lane, "v2-setup")
  assert.equal(logged.at(-1)?.index, 0, "the OPTIONAL failure is the one logged")
  assert.equal(logged.at(-1)?.name, "flakyObserver")
  await dispose()

  // A declared-fatal lane fails the whole setup and unwinds prior disposers.
  let released = false
  await assert.rejects(
    setupLanes({}, helpers, [
      function first() { return () => { released = true } },
      { setup: function core() { throw new Error("core dead") }, fatal: true },
    ]),
    /core dead/,
  )
  assert.equal(released, true, "fatal failure unwinds already-registered lanes")

  // Legacy shape preserved: bare functions, index 0 fatal.
  await assert.rejects(setupLanes({}, helpers, [() => { throw new Error("legacy core") }, () => {}]), /legacy core/)
} finally {
  rmSync(errRoot, { recursive: true, force: true })
}

console.log("v2 subagent stream coverage: ok")
