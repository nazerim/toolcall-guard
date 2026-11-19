import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setupLanes } from "../plugin-v2/setup-lanes.js"

const root = mkdtempSync(join(tmpdir(), "guard-lanes-"))
const helpers = { DATA_DIR: () => root }
const errors = join(root, "toolcall-guard.errors")

try {
  const actions = []
  const hooks = ["a", "b"].map(id => async () => {
    actions.push(id)
    return async () => actions.push(`stop:${id}`)
  })
  const cleanup = await setupLanes({}, helpers, hooks)
  await cleanup()
  await cleanup()
  assert.deepEqual(actions.splice(0), ["a", "b", "stop:b", "stop:a"])

  // Optional lane failure: non-fatal, logged with metadata only, partial
  // registrations of that lane released, later lanes still run.
  const live = new Set()
  const ctx = {
    session: {
      hook: async (name) => {
        live.add(name)
        return { dispose: () => live.delete(name) }
      },
    },
  }
  async function setupBroken(c) {
    await c.session.hook("broken-partial")
    const err = new Error("SECRET-PAYLOAD should not be logged")
    err.code = "EFIXTURE"
    throw err
  }
  const ok = await setupLanes(ctx, helpers, [...hooks, setupBroken, async () => { actions.push("c") }])
  assert.deepEqual(actions.splice(0), ["a", "b", "c"])
  assert.equal(live.has("broken-partial"), false)
  const lines = readFileSync(errors, "utf8").trim().split("\n").map(l => JSON.parse(l))
  assert.equal(lines.length, 1)
  assert.deepEqual({ ...lines[0], at: undefined },
    { at: undefined, lane: "v2-setup", index: 2, name: "setupBroken", code: "EFIXTURE" })
  assert.doesNotMatch(readFileSync(errors, "utf8"), /SECRET-PAYLOAD/)
  await ok()
  assert.deepEqual(actions.splice(0), ["stop:b", "stop:a"])
  rmSync(errors)

  // Core (first lane) failure fails the plugin, releases its partial hooks,
  // and writes no optional-lane line.
  await assert.rejects(setupLanes(ctx, helpers, [async (c) => {
    await c.session.hook("core-partial")
    throw Error("registration")
  }, ...hooks]), /registration/)
  assert.equal(live.size, 0)
  assert.deepEqual(actions, [])
  assert.equal(existsSync(errors), false)
} finally {
  rmSync(root, { recursive: true, force: true })
}
