// Entry-level test: runs the real plugin-v2/index.js (core + every lane)
// against a fake V2 ctx. Each scenario is a fresh node process because the
// core reads TOOLCALL_GUARD at import time; the env is built from scratch
// (no inherited TOOLCALL_GUARD_*), with a private HOME/XDG data dir.
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const entry = pathToFileURL(fileURLToPath(new URL("../plugin-v2/index.js", import.meta.url))).href
const root = mkdtempSync(join(tmpdir(), "guard-entry-"))
after(() => rmSync(root, { recursive: true, force: true }))

const CORE = ["http.response", "context", "compaction", "generate", "title"]
const FLAGS = {
  TOOLCALL_GUARD_PREFLIGHT: "log",
  TOOLCALL_GUARD_CLAMP: "1",
  TOOLCALL_GUARD_BINARY: "1",
  TOOLCALL_GUARD_SUBREPORT: "log",
  TOOLCALL_GUARD_SCRUB: "log",
  TOOLCALL_GUARD_AUDIT: "log",
  TOOLCALL_GUARD_JANITOR: "dry",
}

const runner = `
const { default: plugin } = await import(${JSON.stringify(entry)})
const live = new Map(), subs = []
let seq = 0
const register = (ns) => async (name) => {
  const id = ns + ":" + name + "#" + seq++
  live.set(id, true)
  return { dispose: () => { live.delete(id) } }
}
const ctx = {
  location: { directory: "/fixture" },
  provider: { list: async () => [] },
  session: {
    hook: register("session"),
    get: async () => ({}), context: async () => [], prompt: async () => {},
  },
  event: {
    subscribe(opts) {
      const signal = opts && opts.signal
      subs.push(signal)
      return { async *[Symbol.asyncIterator]() {
        if (!signal) return
        await new Promise((r) => signal.aborted ? r() : signal.addEventListener("abort", r, { once: true }))
      } }
    },
  },
}
if (process.env.FAKE_TOOL !== "0") ctx.tool = { hook: register("tool") }
const names = () => [...live.keys()].map((k) => k.replace(/#\\d+$/, "")).sort()
const out = { id: plugin.id }
try {
  const cleanup = await plugin.setup(ctx)
  await new Promise((r) => setImmediate(r))
  out.hooks = names()
  out.subscriptions = subs.length
  out.activeSubs = subs.filter((s) => s && !s.aborted).length
  out.cleanup = typeof cleanup
  if (typeof cleanup === "function") await cleanup()
  out.afterHooks = names()
  out.afterActiveSubs = subs.filter((s) => s && !s.aborted).length
} catch (err) {
  out.threw = String(err && err.name)
}
process.stdout.write(JSON.stringify(out))
`

let n = 0
function scenario(extra, fakeTool = true) {
  const home = join(root, `s${n++}`)
  const data = join(home, "xdg-data")
  mkdirSync(join(data, "opencode"), { recursive: true })
  const env = { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: join(home, "xdg-config"), XDG_STATE_HOME: join(home, "xdg-state"),
    XDG_CACHE_HOME: join(home, "xdg-cache"), FAKE_TOOL: fakeTool ? "1" : "0", ...extra }
  const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", runner],
    { env, encoding: "utf8", timeout: 20_000 }))
  const errorsPath = join(data, "opencode", "toolcall-guard.errors")
  out.errors = existsSync(errorsPath) ? readFileSync(errorsPath, "utf8") : ""
  return out
}
const session = (names) => names.map((h) => `session:${h}`)
const sorted = (a) => [...a].sort()

test("no flags: only core hooks and the auto-continue subscription", () => {
  const out = scenario({})
  assert.equal(out.id, "toolcall-guard")
  assert.equal(out.threw, undefined)
  assert.deepEqual(out.hooks, sorted(session(CORE)))
  assert.equal(out.subscriptions, 1)
  assert.equal(out.activeSubs, 1)
  assert.deepEqual(out.afterHooks, [])
  assert.equal(out.afterActiveSubs, 0)
  assert.equal(out.errors, "")
})

for (const off of ["off", "OFF"]) {
  test(`TOOLCALL_GUARD=${off} with all seven lane flags: core hooks only`, () => {
    const out = scenario({ TOOLCALL_GUARD: off, ...FLAGS })
    assert.equal(out.threw, undefined)
    assert.deepEqual(out.hooks, sorted(session(CORE)))
    assert.equal(out.subscriptions, 0)
    assert.equal(out.cleanup, "function")
    assert.deepEqual(out.afterHooks, [])
    assert.equal(out.errors, "")
  })
}

test("all flags on: every lane registers and teardown releases everything", () => {
  const out = scenario(FLAGS)
  assert.equal(out.threw, undefined)
  assert.deepEqual(out.hooks, sorted([
    ...session(CORE),
    "session:context", // subreport
    "session:context", // confab
    "tool:execute.before", // preflight + clamp
    "tool:execute.after", // binary
  ]))
  assert.equal(out.subscriptions, 2) // core auto-continue + audit
  assert.equal(out.activeSubs, 2)
  assert.deepEqual(out.afterHooks, [])
  assert.equal(out.afterActiveSubs, 0)
  assert.equal(out.errors, "")
})

test("failing optional lane (no ctx.tool, PREFLIGHT=log) is non-fatal", () => {
  const out = scenario({ TOOLCALL_GUARD_PREFLIGHT: "log" }, false)
  assert.equal(out.threw, undefined)
  assert.deepEqual(out.hooks, sorted(session(CORE)))
  assert.equal(out.subscriptions, 1)
  const lines = out.errors.trim().split("\n").map((l) => JSON.parse(l))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].lane, "v2-setup")
  assert.equal(lines[0].index, 1)
  assert.equal(lines[0].name, "setupPreflight")
  assert.equal(lines[0].code, "TypeError")
  assert.deepEqual(Object.keys(lines[0]).sort(), ["at", "code", "index", "lane", "name"])
  assert.deepEqual(out.afterHooks, [])
  assert.equal(out.afterActiveSubs, 0)
})
