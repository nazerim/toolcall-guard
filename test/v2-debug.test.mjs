import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "tcg-debug-"))
process.env.TOOLCALL_GUARD_DATA_DIR = dir
process.env.TOOLCALL_GUARD = ""
const { default: plugin } = await import("../plugins/toolcall-guard.js")
const settings = { apiKey: "synthetic-canary", headers: { authorization: "synthetic-header" } }
const providers = [
  { id: "outer", info: { id: "inner", package: "openai-compatible", settings }, settings },
  { id: "flat", npm: "adapter", options: settings },
  { id: "custom", package: "https://example.invalid/private?auth=synthetic-canary" },
  { id: settings, npm: "adapter" }, { id: "malformed", package: settings },
]
try {
  for (const raw of [providers, { location: settings, data: providers }]) {
    process.env.TOOLCALL_GUARD_V2_DEBUG = "dump"
    writeFileSync(join(dir, "toolcall-guard.provider-dump.json"), "old", { mode: 0o644 })
    await plugin.setup({
      provider: { list: async () => raw }, session: { hook: async () => {} },
      event: { async *subscribe() {} },
    })
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "toolcall-guard.provider-dump.json"))), [
      { id: "outer", openaiCompatible: true }, { id: "flat", openaiCompatible: false },
      { id: "custom", openaiCompatible: false },
    ])
    assert.equal(statSync(join(dir, "toolcall-guard.provider-dump.json")).mode & 0o777, 0o600)
    rmSync(join(dir, "toolcall-guard.provider-dump.json"))
  }
  process.env.TOOLCALL_GUARD_V2_DEBUG = "events"
  await plugin.setup({
    provider: { list: async () => [] }, session: { hook: async () => {} },
    event: { async *subscribe() {
      yield { type: settings, event: settings, data: settings }
      yield { type: "session.idle", event: settings }
    } },
  })
  await new Promise(resolve => setImmediate(resolve))
  const events = readFileSync(join(dir, "toolcall-guard.events"), "utf8").trim().split("\n").map(s => JSON.parse(s))
  assert.deepEqual(events.map(({ at, ...fields }) => fields), [{ type: "other" }, { type: "session.idle" }])
} finally {
  rmSync(dir, { recursive: true, force: true })
}
