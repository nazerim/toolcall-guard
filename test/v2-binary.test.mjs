import assert from "node:assert/strict"
import { test } from "node:test"
import { setupBinary } from "../plugin-v2/binary.js"

test("only opted-in native completed text is filtered", async (t) => {
  const env = process.env
  const old = [env.TOOLCALL_GUARD, env.TOOLCALL_GUARD_BINARY]
  t.after(() => {
    for (const [i, key] of ["TOOLCALL_GUARD", "TOOLCALL_GUARD_BINARY"].entries()) {
      if (old[i] === undefined) delete env[key]
      else env[key] = old[i]
    }
  })
  let hook
  const ctx = { tool: { hook(name, fn) { assert.equal(name, "execute.after"); hook = fn } } }
  delete env.TOOLCALL_GUARD
  delete env.TOOLCALL_GUARD_BINARY
  await setupBinary(ctx)
  assert.equal(hook, undefined)
  env.TOOLCALL_GUARD_BINARY = "1"
  env.TOOLCALL_GUARD = "OFF"
  await setupBinary(ctx)
  assert.equal(hook, undefined)
  delete env.TOOLCALL_GUARD
  await setupBinary(ctx)
  const text = { type: "text", text: "猫\t\n" }
  const media = { type: "file", mime: "image/gif", uri: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" }
  const metadata = { truncated: false }
  const event = { status: "completed", result: { content: [text, media], metadata } }
  const original = event.result
  hook(event)
  assert.equal(event.result, original)
  event.result.content.push({ type: "text", text: "x\0y" })
  const failed = { ...event, status: "error" }
  hook(failed)
  assert.equal(failed.result, original)
  hook(event)
  assert.equal(event.result.content[0], text)
  assert.equal(event.result.content[1], media)
  assert.equal(event.result.metadata, metadata)
  assert.match(event.result.content[2].text, /binary output suppressed/)
  assert.ok(!event.result.content[2].text.includes("\0"))
})
