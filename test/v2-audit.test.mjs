import assert from "node:assert/strict"
import { after, test } from "node:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import core from "../plugins/toolcall-guard.js"
import { __test as auditState, setupAudit } from "../plugin-v2/audit.js"

const root = mkdtempSync(join(tmpdir(), "guard-audit-"))
after(() => rmSync(root, { recursive: true, force: true }))

const completion = "session.execution.succeeded"
const location = { directory: "/fixture", project: { id: "test" } }
const dangling = "I will now run the fixture checks:"
const pending = "I still need to run the fixture checks."
const request = "PRIVATE-FIXTURE request"
const sid = "ses_fixture"
let sequence = 0
function turn(text = pending, options = {}) {
  const n = ++sequence
  const event = { id: `evt_${n}`, type: completion, created: Date.now(), data: { sessionID: sid } }
  const messages = [
    { type: "user", id: `msg_user_${n}`, text: request, files: [{ uri: "file:///private-fixture" }] },
    ...(options.prior ?? []),
    { type: "assistant", id: `msg_assistant_${n}`, agent: "build",
      model: { providerID: "fixture", id: "older" }, finish: "stop",
      content: [{ type: "reasoning", text: "PRIVATE-REASONING" }, { type: "text", text }],
      ...options.assistant },
    { type: "idle", id: `msg_${n}`, outcome: "succeeded" },
  ]
  return { event: { ...event, ...options.event }, messages,
    info: { id: sid, outcome: "succeeded", location, agent: "plan", model: { providerID: "fixture", id: "current" },
      ...options.info } }
}

async function fixture(t, { mode = "1", master = "on", danglingMode = "nudge", dir, url, threshold, send = "1" } = {}) {
  for (const [key, value] of Object.entries({ AUDIT: mode, "": master, DANGLING: danglingMode, RIZZO: url, AUDIT_T: threshold, AUDIT_SEND: send, RIZZO_MODEL: undefined })) {
    const k = `TOOLCALL_GUARD${key ? `_${key}` : ""}`
    if (value == null) delete process.env[k]
    else process.env[k] = value
  }
  dir ??= mkdtempSync(join(root, "fixture-"))
  let deliver, current, reads = 0, subscriptions = 0, streamSignal
  const prompts = []
  const stopped = Promise.withResolvers()
  const stop = await setupAudit({
    location,
    event: {
      async *subscribe({ types, signal }) {
        subscriptions++
        assert.deepEqual(types, [completion])
        streamSignal = signal
        try {
          while (!signal.aborted) {
            const { event, done } = await new Promise((resolve) => {
              deliver = resolve
              signal.addEventListener("abort", () => resolve({}), { once: true })
            })
            if (!event) return
            yield event
            done()
          }
        } finally { stopped.resolve() }
      },
    },
    session: {
      get: async ({ sessionID }) => {
        reads++
        assert.equal(sessionID, sid)
        return current.hang ? new Promise(() => {}) : current.info
      },
      context: async () => ({ data: current.messages }),
      prompt: async (input) => { prompts.push(input) },
    },
  }, { ...core.__test, DATA_DIR: () => dir })
  t.after(async () => { if (stop) { stop(); await stopped.promise } })
  return { dir, stop, get streamSignal() { return streamSignal },
    get reads() { return reads }, subscriptions, prompts,
    send: (next) => new Promise((done) => { current = next; deliver({ event: next.event, done }) }),
    get logs() {
      const file = join(dir, "toolcall-guard.audit")
      return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : []
    },
  }
}

function mockClassifier(t, response = () => Response.json({ answers: { q: { probabilities: { assistant: 0.55,
  unexpected: "DO NOT LOG RESPONSE CONTENT" } } } })) {
  const calls = []
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), ...options, body: JSON.parse(options.body) })
    return response(options)
  })
  return calls
}

test("off and unsupported flags never subscribe, even with DANGLING=nudge", async (t) => {
  for (const mode of ["", "off", "0", "true", "typo"]) assert.equal((await fixture(t, { mode })).subscriptions, 0)
  assert.equal((await fixture(t, { mode: "1", master: "OFF" })).subscriptions, 0)
})

test("residue score is an observation; mode cutoffs, allowlisted body and content-free logs", async (t) => {
  const calls = mockClassifier(t)
  for (const [mode, threshold, fired] of [["1", "", true], ["log", "", true], ["overnight", "", false],
    ["1", "0.55", false], ["overnight", "1.1", false]]) {
    const f = await fixture(t, { mode, threshold })
    const input = turn()
    await f.send(input)
    await f.send(input)
    assert.equal(f.logs.length, 1)
    assert.deepEqual({ ...f.logs[0], at: "<time>" }, { v: 4, at: "<time>", mode,
      stage: "residue", child: false, p: 0.55, fired })
    assert.deepEqual(f.prompts, [])
  }
  assert.equal(calls.length, 5)
  const [{ url, method, redirect, credentials, body, signal }] = calls
  assert.equal(url, "http://127.0.0.1:8017/v1/systemone")
  assert.equal(method, "POST")
  assert.equal(redirect, "error")
  assert.equal(credentials, "omit")
  assert.equal(signal.aborted, false)
  assert.deepEqual(body.state, { user_request: request, assistant_final: pending })
  assert.deepEqual(body.questions, core.__test.AUDIT_Q)
})

test("nudge is deterministic, explicit, deduplicated across setup and never changes agent or model", async (t) => {
  const calls = mockClassifier(t)
  const f = await fixture(t, { mode: "overnight" })
  const other = await fixture(t, { dir: f.dir })
  const input = turn(dangling)
  await Promise.all([f.send(input), other.send(input)])
  await f.send({ ...input, event: { ...input.event, type: "session.idle" } })
  const [sent] = [...f.prompts, ...other.prompts]
  assert.equal(f.prompts.length + other.prompts.length, 1)
  assert.equal(sent.sessionID, sid)
  assert.match(sent.id, /^msg_[a-f0-9]{64}$/)
  assert.equal(sent.delivery, "queue")
  assert.deepEqual(Object.keys(sent).sort(), ["delivery", "id", "sessionID", "text"])
  assert.ok(!sent.text.includes(dangling))
  await f.send(turn(dangling))
  await other.send(turn(dangling)) // budget shared across instances
  assert.equal(f.prompts.length + other.prompts.length, 2)
  assert.equal(calls.length, 0)
  const logOnly = await fixture(t, { mode: "log" })
  await logOnly.send(turn(dangling))
  assert.equal(logOnly.logs[0].nudged, false)
  assert.deepEqual(logOnly.prompts, [])
})

test("aborted, stale, auxiliary, clipped, wrong-location, and tool-final events are skipped", async (t) => {
  const calls = mockClassifier(t)
  const f = await fixture(t)
  for (const input of [
    turn(dangling, { event: { type: "session.execution.interrupted" } }),
    turn(dangling, { event: { created: Date.now() - 11_000 } }),
    turn(dangling, { event: { id: "evt_different" } }),
    turn(dangling, { assistant: { finish: undefined } }),
    turn(dangling, { assistant: { finish: "content-filter" } }),
    turn(dangling, { assistant: { error: { name: "aborted" } } }),
    turn(dangling, { assistant: { agent: "title" } }),
    turn(dangling, { info: { outcome: "interrupted" } }),
    turn(dangling, { info: { location: { directory: "/different" } } }),
    turn(dangling, { assistant: { content: [{ type: "tool", name: "read" }] } }),
    turn("The fixture reply clips here `"),
    turn(""),
  ]) await f.send(input)
  assert.deepEqual(f.logs, [])
  assert.deepEqual(f.prompts, [])
  assert.equal(calls.length, 0)
})

test("child, questions, offers and dangling turns with earlier tools never prompt or send classifier text", async (t) => {
  const calls = mockClassifier(t)
  const f = await fixture(t)
  const child = { info: { parentID: "ses_parent" } }
  await f.send(turn(pending, child))
  await f.send(turn(dangling, child))
  await f.send(turn("Would you like me to verify?"))
  await f.send(turn("Let me know if you want another check."))
  await f.send(turn(dangling, { prior: [{ type: "assistant", content: [{ type: "tool" }] }] }))
  assert.deepEqual(f.logs.map((r) => [r.stage, r.child]), [
    ["residue", true], ["dangling", true], ["question", false], ["offer", false], ["dangling", false],
  ])
  assert.deepEqual(f.prompts, [])
  assert.equal(calls.length, 0)
})

test("classifier quota and loopback-only endpoint", async (t) => {
  const calls = mockClassifier(t)
  for (const url of ["http://example.com/v1/systemone", "http://localhost.example.com", "http://a:b@localhost",
    "file:///tmp/test", "http://localhost:8017/v1/systemone", "http://127.0.0.1:8017/v1/systemone?token=x",
    "http://127.0.0.1:8017/v1/systemone#x", "http://a:b@127.0.0.1:8017/v1/systemone", "http://u@[::1]:8017/"]) {
    const f = await fixture(t, { url })
    await f.send(turn())
    // Rejected endpoint: residue stays a local, unscored observation.
    assert.deepEqual(f.logs.map((r) => [r.stage, r.fired, r.p]), [["residue", false, undefined]])
  }
  assert.equal(calls.length, 0)
  const f = await fixture(t, { url: "http://[::1]:8017/v1/systemone" })
  for (let i = 0; i < 17; i++) await f.send(turn("x".repeat(1200) + pending))
  assert.equal(calls.length, 15)
  assert.equal(calls[0].body.state.assistant_final.length, 800)
  assert.ok(calls[0].body.state.assistant_final.endsWith(pending))
  f.stop()
  assert.equal(f.streamSignal.aborted, true)
})

test("classifier failure cools down, redacts error details and does not nudge", async (t) => {
  const calls = mockClassifier(t, () => { throw new Error("PRIVATE-FIXTURE error details") })
  const f = await fixture(t)
  await f.send(turn())
  await f.send(turn())
  assert.equal(calls.length, 1)
  assert.equal(f.logs.length, 1)
  assert.equal(f.logs[0].error, "classifier-unavailable")
  assert.ok(!JSON.stringify(f.logs).includes("PRIVATE"))
  assert.deepEqual(f.prompts, [])
})

test("hung host call is cut at the event deadline; the lane keeps serving", async (t) => {
  // Classifier cooldown is process-wide; use the model-free dangling stage.
  const f = await fixture(t, { mode: "log" })
  const stuck = turn(dangling, { event: { created: Date.now() - 9_950 } })
  await f.send({ ...stuck, hang: true })
  await f.send(turn(dangling))
  assert.deepEqual(f.logs.map((r) => r.stage), ["dangling"])
})

test("without AUDIT_SEND=1 the lane observes locally and never fetches", async (t) => {
  const calls = mockClassifier(t)
  for (const send of [null, "0", "true", "yes"]) {
    const f = await fixture(t, { send })
    await f.send(turn())
    await f.send(turn(dangling))
    assert.deepEqual(f.logs.map((r) => [r.stage, r.fired, r.p]), [["residue", false, undefined], ["dangling", true, undefined]])
    assert.ok(!JSON.stringify(f.logs).includes("PRIVATE"))
  }
  assert.equal(calls.length, 0)
})

test("replies to core and own nudges are not scored", async (t) => {
  const calls = mockClassifier(t)
  const f = await fixture(t)
  const core = turn()
  core.messages[0].text = "[toolcall-guard auto-continue] Your previous reply was truncated ..."
  const own = turn(dangling)
  own.messages[0].text = "[toolcall-guard turn audit] Your previous reply ended ..."
  await f.send(core)
  await f.send(own)
  assert.deepEqual(f.logs, [])
  assert.deepEqual(f.prompts, [])
  assert.equal(calls.length, 0)
})

test("oversized classifier reply is refused and cools down", async (t) => {
  const calls = mockClassifier(t, () => new Response(JSON.stringify({ answers: { q: { probabilities: { assistant: 0.9 } } },
    pad: "x".repeat(20_000) })))
  // Step past the process-wide cooldown left by the earlier failure test.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 61_000 })
  const f = await fixture(t)
  await f.send(turn())
  assert.equal(calls.length, 1)
  assert.deepEqual(f.logs.map((r) => [r.error, r.p]), [["classifier-unavailable", undefined]])
})

test("session cap evicts idle sessions; a full active cap skips with one metadata line", async (t) => {
  const { states, maxSessions, idleMs } = auditState
  t.after(() => states.clear())
  const fill = (seen) => {
    states.clear()
    for (let i = 0; i < maxSessions; i++) states.set(`filler-${i}`, { events: new Set(), scores: 0, nudges: 0, seen })
  }
  fill(Date.now())
  const f = await fixture(t, { mode: "log" })
  await f.send(turn(dangling))
  await f.send(turn(dangling))
  assert.deepEqual(f.logs.map(({ at, ...r }) => r), [{ v: 4, mode: "log", stage: "skipped", child: false, reason: "session-cap" }])
  fill(Date.now() - idleMs - 1)
  await f.send(turn(dangling))
  assert.deepEqual(f.logs.map((r) => r.stage), ["skipped", "dangling"])
  assert.equal(states.size, 1)
})
