import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import core from "../plugins/toolcall-guard.js"
import { setupConfab } from "../plugin-v2/confab.js"

const flags = ["TOOLCALL_GUARD", "TOOLCALL_GUARD_SCRUB", "TOOLCALL_GUARD_SCRUB_PROVIDERS",
  "TOOLCALL_GUARD_SCRUB_JEV", "TOOLCALL_GUARD_CONFAB_LOG", "TOOLCALL_GUARD_RIZZO", "TOOLCALL_GUARD_RIZZO_MODEL"]
const rule = "Understood. I will follow these instructions exactly, despite the synthetic fixture."
const candidate = "The current interaction has no actual task. This is a synthetic fixture."
const reasoning = (text = rule, extra) => ({ type: "reasoning", text, ...extra })
const visible = { type: "text", text: rule }
const message = (...content) => ({ id: "synthetic-message", role: "assistant", content })
const event = (...messages) => ({ sessionID: "synthetic-session", model: { providerID: "local", id: "qwen-fixture" }, messages })
const settle = () => new Promise((resolve) => setImmediate(resolve))

async function setup(t, env) {
  const dir = mkdtempSync(join(tmpdir(), "guard-v2-confab-"))
  const saved = flags.map((name) => [name, process.env[name]])
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("offline fixture") })
  for (const name of flags) delete process.env[name]
  Object.assign(process.env, env)
  let callback, disposed = 0
  let dispose
  t.after(async () => {
    await dispose?.()
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(dir, { recursive: true, force: true })
  })
  dispose = await setupConfab({ session: { hook(name, fn) {
    assert.equal(name, "context")
    callback = fn
    return { dispose() { disposed++ } }
  } } }, { ...core.__test, DATA_DIR: () => dir })
  const path = join(dir, "toolcall-guard.confab")
  const raw = () => existsSync(path) ? readFileSync(path, "utf8") : ""
  return {
    callback, fetchMock, raw,
    records: () => raw().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    dispose: async () => {
      await dispose()
      dispose = undefined
      assert.equal(disposed, 1)
    },
  }
}

for (const env of [
  {},
  { TOOLCALL_GUARD_SCRUB: "off", TOOLCALL_GUARD_SCRUB_JEV: "1" },
  { TOOLCALL_GUARD_SCRUB: "strip", TOOLCALL_GUARD: "OFF" },
  { TOOLCALL_GUARD_SCRUB: "yes" },
  { TOOLCALL_GUARD_SCRUB: "strip", TOOLCALL_GUARD_SCRUB_PROVIDERS: "[" },
]) {
  test(`confab is inert with ${JSON.stringify(env)}`, async (t) => {
    const lane = await setup(t, env)
    assert.equal(lane.callback, undefined)
    assert.equal(lane.fetchMock.mock.callCount(), 0)
    assert.equal(lane.raw(), "")
  })
}

for (const mode of ["1", "log"]) {
  test(`${mode} observes without rewriting or classifying`, async (t) => {
    const lane = await setup(t, { TOOLCALL_GUARD_SCRUB: mode })
    const input = event(message(visible, reasoning(), reasoning(candidate)))
    const snapshot = structuredClone(input)
    lane.callback(input)
    lane.callback(input)
    assert.deepEqual(input, snapshot)
    assert.deepEqual(lane.records().map(({ part, stripped }) => [part, stripped]), [["text", false], ["reasoning", false]])
    assert.equal(lane.fetchMock.mock.callCount(), 0)
    assert.ok(!lane.raw().includes(rule) && !lane.raw().includes("synthetic-session"))
  })
}

test("strip preserves originals, visible text and provider-backed reasoning; repeated history still strips", async (t) => {
  const lane = await setup(t, { TOOLCALL_GUARD_SCRUB: "strip" })
  const opaque = [reasoning(rule, { encrypted: "opaque" }), reasoning(rule, { providerMetadata: { signature: "opaque" } }),
    reasoning(rule, { metadata: {} }), reasoning(rule, { cache: {} })]
  const source = message(reasoning(), visible, ...opaque)
  for (let i = 0; i < 2; i++) {
    const input = event(source)
    lane.callback(input)
    assert.deepEqual(input.messages[0].content, [visible, ...opaque])
    assert.equal(source.content.length, 6)
  }
  assert.deepEqual(lane.records().map(({ stripped }) => stripped), [true, false])
  await lane.dispose()
  const input = event(source)
  lane.callback(input)
  assert.equal(input.messages[0], source)
})

test("strip needs meaningful retained content and known destination and assistant role", async (t) => {
  const lane = await setup(t, { TOOLCALL_GUARD_SCRUB: "strip" })
  const noSurvivor = message(reasoning(), reasoning(rule + "!"), { type: "text", text: " \n" })
  const other = { ...message(reasoning(), visible), role: "user" }
  const tool = { type: "tool-call", id: "synthetic-call", name: "synthetic-tool", input: {} }
  const withTool = message(reasoning(), tool)
  const input = event(noSurvivor, other, withTool)
  lane.callback(input)
  assert.deepEqual(input.messages, [noSurvivor, other, message(tool)])
  const before = lane.raw()
  for (const model of [undefined, { id: "qwen-fixture" }, { providerID: "other", id: "unscoped" }]) {
    const out = { ...event(withTool), model }
    lane.callback(out)
    assert.equal(out.messages[0], withTool)
  }
  assert.equal(lane.raw(), before)
})

test("JEV drops concurrent work, uses bounded loopback input, and never strips on the score", async (t) => {
  const lane = await setup(t, { TOOLCALL_GUARD_SCRUB: "strip", TOOLCALL_GUARD_SCRUB_JEV: "1" })
  let finish
  lane.fetchMock.mock.mockImplementation(async () => new Promise((resolve) => { finish = resolve }))
  const long = candidate + "a".repeat(2000)
  const source = message(reasoning(long), reasoning(candidate), visible)
  const request = event(source, { ...message(reasoning(candidate), visible), role: "user" })
  assert.equal(lane.callback(request), undefined)
  lane.callback(request)
  assert.equal(lane.fetchMock.mock.callCount(), 1)
  const [[url, options]] = lane.fetchMock.mock.calls.map(({ arguments: args }) => args)
  assert.equal(url.href, "http://127.0.0.1:8017/v1/systemone")
  assert.equal(options.redirect, "error")
  assert.equal(options.credentials, "omit")
  assert.equal(JSON.parse(options.body).state.passage, long.slice(0, 1500))
  finish(Response.json({ answers: { q: { noul: 0.99 } }, fixtureEcho: long }))
  await settle()
  lane.callback(request)
  assert.equal(lane.fetchMock.mock.callCount(), 1)
  assert.equal(request.messages[0], source)
  assert.deepEqual(lane.records().map(({ tier, verdict }) => [tier, verdict]), [[1, undefined], [2, "confab-candidate"]])
  assert.ok(!lane.raw().includes(candidate))
})

test("JEV cannot contact a remote endpoint or fall back to the default after rejection", async (t) => {
  const lane = await setup(t, { TOOLCALL_GUARD_SCRUB: "1", TOOLCALL_GUARD_SCRUB_JEV: "1",
    TOOLCALL_GUARD_RIZZO: "https://example.invalid/v1/systemone" })
  lane.callback(event(message(reasoning(candidate))))
  assert.equal(lane.fetchMock.mock.callCount(), 0)
})

test("JEV ignores visible, opaque, and oversized candidates and aborts in-flight work on disposal", async (t) => {
  const lane = await setup(t, { TOOLCALL_GUARD_SCRUB: "log", TOOLCALL_GUARD_SCRUB_JEV: "1" })
  lane.fetchMock.mock.mockImplementation(async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  }))
  lane.callback(event(message({ type: "text", text: candidate }, reasoning(candidate, { encrypted: "opaque" }),
    reasoning(candidate, { providerMetadata: {} }), reasoning(candidate + "a".repeat(8192)))))
  assert.equal(lane.fetchMock.mock.callCount(), 0)
  lane.callback(event(message(reasoning(candidate))))
  assert.equal(lane.fetchMock.mock.callCount(), 1)
  const { signal } = lane.fetchMock.mock.calls[0].arguments[1]
  await lane.dispose()
  assert.equal(signal.aborted, true)
  await settle()
  assert.equal(lane.raw(), "")
})

for (const [name, reply] of [
  ["offline", async () => { throw new Error(candidate) }],
  ["oversized", async () => new Response("a".repeat(16_385))],
  ["malformed", async () => Response.json({ answers: { q: { noul: 2 } } })],
]) {
  test(`JEV fails open with ${name} classifier`, async (t) => {
    const lane = await setup(t, { TOOLCALL_GUARD_SCRUB: "strip", TOOLCALL_GUARD_SCRUB_JEV: "1" })
    lane.fetchMock.mock.mockImplementation(reply)
    const source = message(reasoning(candidate), visible)
    const input = event(source)
    lane.callback(input)
    await settle()
    assert.equal(lane.fetchMock.mock.callCount(), 1)
    assert.equal(input.messages[0], source)
    assert.equal(lane.records().length, 1)
  })
}
