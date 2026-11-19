import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import plugin from "../plugins/toolcall-guard.js"
import { setupPreflight } from "../plugin-v2/preflight.js"

test("V2 preflight is opt-in, redacted and preserves explicit timeouts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "guard-preflight-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const keys = ["TOOLCALL_GUARD", "TOOLCALL_GUARD_PREFLIGHT", "TOOLCALL_GUARD_CLAMP", "TOOLCALL_GUARD_CLAMP_MS"]
  for (const k of keys) {
    const old = process.env[k]
    delete process.env[k]
    t.after(() => old === undefined ? delete process.env[k] : process.env[k] = old)
  }
  const register = async () => {
    let hook
    await setupPreflight({ tool: { hook(name, cb) { assert.equal(name, "execute.before"); hook = cb } } },
      { ...plugin.__test, DATA_DIR: () => dir })
    return hook
  }
  assert.equal(await register(), undefined)
  process.env.TOOLCALL_GUARD_PREFLIGHT = "log"
  const event = { tool: "shell", input: { command: "cat private-fixture.gguf" } }
  ;(await register())(event)
  const marker = JSON.parse(readFileSync(join(dir, "toolcall-guard.preflight"), "utf8"))
  assert.deepEqual(marker, { at: marker.at, kind: "pattern", rule: "binary-peek", mode: "log" })
  process.env.TOOLCALL_GUARD_PREFLIGHT = "block"
  const block = await register()
  assert.throws(() => block(event), /refused shell call \(binary-peek\)/)
  block({ ...event, tool: "other" })
  block({ ...event, input: { command: event.input.command + " | head" } })
  process.env.TOOLCALL_GUARD_CLAMP = "1"
  process.env.TOOLCALL_GUARD = "off"
  assert.equal(await register(), undefined)
  delete process.env.TOOLCALL_GUARD
  delete process.env.TOOLCALL_GUARD_PREFLIGHT
  process.env.TOOLCALL_GUARD_CLAMP_MS = "375"
  const clamp = await register()
  const scan = { tool: "shell", input: { command: "find . -type d" } }
  clamp(scan)
  assert.equal(scan.input.timeout, 375)
  for (const timeout of [0, null, 50000]) {
    scan.input.timeout = timeout
    clamp(scan)
    assert.equal(scan.input.timeout, timeout)
  }
})
