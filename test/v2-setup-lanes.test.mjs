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

  // Lane views: wrapped objects expose the real keys, spread/JSON/in agree,
  // each wrapped object has one stable wrapper, and arrays stay arrays.
  const shape = { session: { id: "s", nested: { deep: 1 }, list: [1, 2] }, list: ["x"] }
  shape.alias = shape.session
  let view
  await setupLanes(shape, helpers, [async (c) => { view = c }])
  assert.equal(view.session, view.session)
  assert.equal(view.session, view.alias)
  assert.deepEqual(Object.keys(view.session), ["id", "nested", "list"])
  assert.deepEqual({ ...view.session }, { ...shape.session })
  assert.equal(JSON.stringify(view.session), JSON.stringify(shape.session))
  assert.ok("id" in view.session)
  assert.equal(Object.getOwnPropertyDescriptor(view.session, "id").value, "s")
  assert.equal(Array.isArray(view.list), true)
  assert.deepEqual(Object.keys(view.list), ["0"])
  assert.equal(JSON.stringify(view.list), '["x"]')
  assert.deepEqual([...view.list], ["x"])
  assert.deepEqual(Object.keys(view), ["session", "list", "alias"])

  // Frozen host: non-configurable source properties must not break the views.
  const frozen = Object.freeze({ session: Object.freeze({ id: "f" }), list: Object.freeze(["y"]) })
  let frozenView
  await setupLanes(frozen, helpers, [async (c) => { frozenView = c }])
  assert.deepEqual(Object.keys(frozenView.session), ["id"])
  assert.equal(JSON.stringify(frozenView), JSON.stringify(frozen))
  assert.equal(Array.isArray(frozenView.list), true)
  // Frozen array: the dummy's writable length must win over the source's.
  assert.deepEqual(Object.keys(frozenView.list), ["0"])
  assert.deepEqual({ ...frozenView.list }, { 0: "y" })
  assert.deepEqual(Object.entries(frozenView.list), [["0", "y"]])
  const seenKeys = []
  for (const key in frozenView.list) seenKeys.push(key)
  assert.deepEqual(seenKeys, ["0"])
  assert.equal(Object.getOwnPropertyDescriptor(frozenView.list, "length").value, 1)
} finally {
  rmSync(root, { recursive: true, force: true })
}
