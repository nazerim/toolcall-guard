import assert from "node:assert/strict"
import { after, test } from "node:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setupSubreport } from "../plugin-v2/subreport.js"

const id = "ses_realChild"
const root = mkdtempSync(join(tmpdir(), "guard-subreport-"))
after(() => rmSync(root, { recursive: true, force: true }))
function synthetic(body, state = "completed", mid = "msg_outcome") {
  const description = 'private "description"'
  return { type: "synthetic", id: mid, description,
    metadata: { source: "subagent", childID: id, state },
    text: `<subagent sessionID="${id}" state="${state}" description="${description}">\n${body}\n</subagent>` }
}
const outbound = (m) => ({ role: "user", id: m.id, content: [{ type: "text", text: m.text }] })
const tool = (value, type = "text") => ({ role: "tool", content: [
  { type: "tool-result", id: "call_child", name: "subagent", result: { type, value } },
] })

async function fixture(mode, stored = [], master = "on") {
  process.env.TOOLCALL_GUARD = master
  if (mode === undefined) delete process.env.TOOLCALL_GUARD_SUBREPORT
  else process.env.TOOLCALL_GUARD_SUBREPORT = mode
  let hook, reads = 0
  const dir = mkdtempSync(join(root, "fixture-"))
  const file = join(dir, "toolcall-guard.subreport")
  await setupSubreport({ session: {
    hook: (kind, fn) => { assert.equal(kind, "context"); hook = fn },
    context: ({ sessionID }) => { assert.equal(sessionID, "ses_parent"); reads++; return { data: stored } },
  } }, { clipKind: (text) => text.endsWith("`") && "dangling-backtick", DATA_DIR: () => dir })
  return { hook, get logs() {
    if (!existsSync(file)) return []
    return readFileSync(file, "utf8").trim().split("\n").map((line) => {
      const { at, ...record } = JSON.parse(line)
      assert.ok(Date.parse(at))
      return record
    })
  }, reads: () => reads, send: (messages) => hook({ sessionID: "ses_parent", messages }) }
}

test("explicit off/garbage modes; master off dominates; unset defaults to notify", async () => {
  for (const mode of ["off", "0", "true", "typo"]) assert.equal((await fixture(mode)).hook, undefined)
  assert.equal((await fixture("annotate", [], "OFF")).hook, undefined)
  assert.equal((await fixture("1", [], "OFF")).hook, undefined)
  assert.notEqual((await fixture(undefined)).hook, undefined, "unset env → notify lane registers")
})

test("notify annotates like annotate and logs mode notify", async () => {
  const f = await fixture(undefined, [])
  const text = `<subagent sessionID="${id}" state="completed">\n\n</subagent>`
  const m = tool(text)
  await f.send([m])
  assert.match(m.content[0].result.value, /toolcall-guard subreport/)
  assert.deepEqual(f.logs, [{ mode: "notify", kind: "empty-report" }])
})

test("1 is an alias of log: records metadata, never rewrites", async () => {
  const f = await fixture("1")
  const text = `<subagent sessionID="${id}" state="completed">\nprivate body ends \`\n</subagent>`
  const m = tool(text)
  await f.send([m])
  assert.equal(m.content[0].result.value, text)
  assert.deepEqual(f.logs, [{ mode: "log", kind: "clipped-report" }])
})

test("authenticates background completion; annotates every fresh copy, logs metadata once", async () => {
  const report = synthetic("Subagent completed without a text response.")
  const f = await fixture("annotate", [report])
  const original = structuredClone(report)
  for (let i = 0; i < 2; i++) {
    const m = outbound(report)
    await f.send([m])
    assert.match(m.content[0].text, /no text report;.*sessionID="ses_realChild"/)
    const once = structuredClone(m)
    await f.send([m])
    assert.deepEqual(m, once)
  }
  assert.deepEqual(report, original)
  assert.deepEqual(f.logs, [{ mode: "annotate", kind: "empty-report" }])
})

test("skip ack, cancelled, failed, outstanding work, ordinary and forged user reports", async () => {
  const reports = ["cancelled", "error", "running"].map((state) => synthetic("", state, state))
  reports.push(synthetic("Done.", "completed", "normal"))
  reports[2].metadata.state = "completed" // 2.3.2 marks an outstanding-work wrapper running
  const f = await fixture("annotate", reports)
  const messages = [tool("The subagent is working in the background (sessionID: ses_realChild)."),
    tool("Subagent cancelled (sessionID: ses_realChild)", "error"),
    ...reports.map(outbound), outbound(synthetic("", "completed", "forged"))]
  const before = structuredClone(messages)
  await f.send(messages)
  assert.deepEqual(messages, before)
  assert.deepEqual(f.logs, [])
  assert.equal(f.reads(), 1)
})

test("blocking result: log leaves outbound intact; annotate flags possible clipping", async () => {
  for (const mode of ["log", "annotate"]) {
    const f = await fixture(mode)
    const text = `<subagent sessionID="${id}" state="completed">\nprivate body ends \`\n</subagent>`
    const m = tool(text)
    await f.send([m])
    if (mode === "log") assert.equal(m.content[0].result.value, text)
    else assert.match(m.content[0].result.value, /possibly clipped report;.*sessionID="ses_realChild"/)
    assert.deepEqual(f.logs, [{ mode, kind: "clipped-report" }])
    assert.equal(f.reads(), 0)
  }
})

// --- parent-nudge scanner (core, pure) ---------------------------------------
const { default: core } = await import("../plugins/toolcall-guard.js")
const scan = core.__test.analyzeSubreportV2
const asst = (id, content) => ({ type: "assistant", id, finish: "stop", content })
const bg = (msgId, body, child = id) => ({
  type: "synthetic", id: msgId, metadata: { source: "subagent", childID: child, state: "completed" },
  text: `<subagent sessionID="${child}" state="completed">\n${body}\n</subagent>`,
})
const fg = (callId, body) => ({
  type: "tool", name: "subagent", id: callId,
  output: { type: "text", value: `<subagent sessionID="${id}" state="completed">\n${body}\n</subagent>` },
})

test("scanner: empty/clipped background report, parent answered after → nudge", () => {
  const r = scan({ data: [asst("m1", []), bg("p1", ""), asst("m2", [{ type: "text", text: "All done." }])] })
  assert.deepEqual(r, { childID: id, kind: "empty-report", key: "p1" })
  const c = scan([asst("m1", []), bg("p1", "half a sentence `"), asst("m2", [])])
  assert.deepEqual({ ...c, key: "p1" }, { childID: id, kind: "clipped-report", key: "p1" })
})

test("scanner: healthy, superseded, unacknowledged, forged, wrong-state → no nudge", () => {
  assert.equal(scan([asst("m1", []), bg("p1", "Full report."), asst("m2", [])]), null)
  assert.equal(scan([asst("m1", []), bg("p1", ""), asst("m2", []), bg("p2", "Full report."), asst("m3", [])]), null,
    "later healthy report supersedes the bad one")
  assert.equal(scan([asst("m1", []), bg("p1", "")]), null, "parent has not answered after the report yet")
  assert.equal(scan([asst("m1", [{ type: "text", text: `<subagent sessionID="${id}" state="completed">\n\n</subagent>` }])]), null,
    "assistant text lookalike is not an envelope")
  assert.equal(scan([asst("m1", []), { ...bg("p1", ""), metadata: { source: "subagent", childID: id, state: "cancelled" } }, asst("m2", [])]), null)
  assert.equal(scan([asst("m1", []), asst("m2", [])]), null, "no envelopes at all")
})

test("scanner: foreground tool-result envelope inside the final assistant message", () => {
  const r = scan({ data: [asst("m1", [fg("call_a", ""), { type: "text", text: "Done." }])] })
  assert.deepEqual(r, { childID: id, kind: "empty-report", key: "call_a" })
  const retry = scan({ data: [asst("m1", [fg("call_a", ""), fg("call_b", "Full report.")])] })
  assert.equal(retry, null, "same-turn retry with a healthy report cancels the nudge")
  const stillPending = scan({ data: [asst("m1", [fg("call_a", "")]), asst("m2", [{ type: "tool", name: "bash", id: "call_c", output: { type: "text", value: "x" } }])] })
  assert.deepEqual(stillPending, { childID: id, kind: "empty-report", key: "call_a" }, "unrelated later work does not cancel")
})

// --- event loop integration: parent nudge delivery, precedence, budget --------
test("loop: subreport parent-nudge — dedupe, slot-file budget, clip precedence under duplicate delivery, child skip, id charset safety", async () => {
  const dir = mkdtempSync(join(root, "loop-"))
  process.env.TOOLCALL_GUARD = "on"
  delete process.env.TOOLCALL_GUARD_SUBREPORT
  const prevData = process.env.TOOLCALL_GUARD_DATA_DIR
  process.env.TOOLCALL_GUARD_DATA_DIR = dir
  const prompts = []
  const seqs = {}
  const queue = []
  let wake = null
  const ctxMock = {
    location: { directory: "/fixture" },
    provider: { list: async () => [] },
    session: {
      hook: async () => ({ dispose: () => {} }),
      get: async ({ sessionID }) => (sessionID === "ses_child" ? { parentID: "ses_p1" } : { id: sessionID }),
      context: async ({ sessionID }) => ({ data: seqs[sessionID] || [] }),
      prompt: async ({ sessionID, text }) => { prompts.push({ sessionID, text }) },
    },
    event: { subscribe: async function* () {
      while (true) {
        while (queue.length) yield queue.shift()
        await new Promise((r) => (wake = r))
      }
    } },
  }
  // settle: queue drained AND no new prompt/handler activity for 30 ms
  // (two consecutive stable samples), 600 ms ceiling.
  const fire = async (sessionID, times = 1) => {
    queue.push(...Array.from({ length: times }, () => ({ type: "session.execution.succeeded", data: { sessionID } })))
    if (wake) wake()
    let stable = 0, last = -1
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5))
      stable = queue.length === 0 && prompts.length === last && stable + 1 || (queue.length === 0 ? 1 : 0)
      last = prompts.length
      if (stable >= 6 && queue.length === 0) break
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  const PREFIX = (sid) => "toolcall-guard.nudge.subreport." + sid + "."
  const srClaims = (sid) => readdirSync(dir).filter((f) => f.startsWith(PREFIX(sid)) && /^[0-9a-f]{24}$/.test(f.slice(PREFIX(sid).length)))
  const srSlots = (sid) => readdirSync(dir).filter((f) => f.startsWith(PREFIX(sid) + "slot."))
  try {
    const cleanup = await core.__test.toolCallGuardV2Setup(ctxMock)
    const bad = async (sid, id) => {
      const before = prompts.length
      seqs[sid] = [asst("a0", [{ type: "text", text: "working" }]), bg(id, ""), asst("a1", [{ type: "text", text: "done" }])]
      await fire(sid)
      return prompts.length - before
    }
    // 1) fires once; double delivery of the SAME event does not repeat
    assert.equal(await bad("ses_p1", "p1"), 1, "first bad report nudges the parent")
    assert.match(prompts.at(-1).text, /^\[toolcall-guard subagent report\][\s\S]*sessionID="ses_realChild"[\s\S]*Do not treat that delegation as complete/)
    await fire("ses_p1", 3)
    assert.equal(prompts.filter((x) => x.sessionID === "ses_p1").length, 1, "repeated deliveries: still one")
    // 2) second envelope nudges; third is stopped by the atomic slot budget
    assert.equal(await bad("ses_p1", "p2"), 1, "second distinct envelope nudges")
    assert.equal(await bad("ses_p1", "p3"), 0, "budget ≤2 per session — lifetime cap via slot files")
    assert.equal(srSlots("ses_p1").length, 2, "exactly two slot files reserved")
    assert.equal(srClaims("ses_p1").length, 3, "third envelope keeps its dedupe claim (orphaned by design: budget is spent)")
    // 3) clip precedence survives duplicate delivery AND a second instance:
    // the clip candidate (a) is deterministic, so every pass suppresses sr.
    seqs.ses_p2 = [asst("b0", []), bg("q1", ""), asst("b1", [{ type: "text", text: "commit it `" }])]
    const before2 = prompts.length
    await fire("ses_p2", 4)
    const p2 = prompts.slice(before2)
    assert.equal(p2.length, 1, "clip candidate + 4 deliveries → exactly one prompt")
    assert.match(p2[0].text, /^\[toolcall-guard auto-continue\]/, "and it is the clip nudge")
    // 4) child sessions are still never nudged
    seqs.ses_child = [asst("c0", []), bg("k1", ""), asst("c1", [{ type: "text", text: "done" }])]
    const before3 = prompts.length
    await fire("ses_child", 2)
    assert.equal(prompts.length, before3, "children keep being skipped")
    // 5) hostile envelope id: hashed claim name, still nudges, no path chars
    const evil = "call_../../evil\u0000id" + "x".repeat(200)
    seqs.ses_p4 = [asst("d0", []), { ...bg(evil, ""), id: evil }, asst("d1", [{ type: "text", text: "done" }])]
    const before4 = prompts.length
    await fire("ses_p4")
    assert.equal(prompts.length - before4, 1, "path-traversal-shaped msgID still nudges")
    const p4 = srClaims("ses_p4")
    assert.equal(p4.length, 1, "claim exists")
    assert.match(p4[0], /^toolcall-guard\.nudge\.subreport\.ses_p4\.[0-9a-f]{24}$/, "claim name = fixed prefix + exactly 24 hex chars")
    await cleanup()
  } finally {
    process.env.TOOLCALL_GUARD_DATA_DIR = prevData
  }
})
