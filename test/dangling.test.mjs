import assert from "node:assert/strict"
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs"
process.env.HOME = "/tmp/tcg-dangling-home"
process.env.TOOLCALL_GUARD_AUDIT = "1"
process.env.TOOLCALL_GUARD_DANGLING = "nudge"
mkdirSync(process.env.HOME + "/.local/share/opencode", { recursive: true })
for (const f of ["clips", "audit", "idles"]) {
  try { rmSync(`${process.env.HOME}/.local/share/opencode/toolcall-guard.${f}`) } catch {}
}
const { default: plugin } = await import("../plugins/toolcall-guard.js")

const DANGLING_TEXT = "Verified the cache prefix. Banking now — evidence file, handover update, commit + push:"
const assistantMsg = (id, text, extraParts = []) => ({
  info: { role: "assistant", id, providerID: "ds4-qwen", modelID: "qwen3.8-flash-next", agent: "build", time: { created: 1 } },
  parts: [{ type: "text", text }, { type: "step-finish" }, ...extraParts],
})
const userMsg = (id) => ({ info: { role: "user", id, time: { created: 0 } }, parts: [{ type: "text", text: "do the thing" }] })

const makeClient = (history, { sub = false } = {}) => {
  const prompts = []
  return {
    prompts,
    session: {
      get: async () => ({ data: { id: "ses_x", ...(sub ? { parentID: "ses_parent" } : {}) } }),
      messages: async () => ({ data: history }),
      prompt: async ({ body }) => { prompts.push(body); return { data: {} } },
    },
  }
}
const clips = () =>
  existsSync(`${process.env.HOME}/.local/share/opencode/toolcall-guard.clips`)
    ? readFileSync(`${process.env.HOME}/.local/share/opencode/toolcall-guard.clips`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : []
const fire = async (hooks) => hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_x" } } })

// main session, dangling ending, zero tool calls -> one nudge with the fact-based text
{
  const history = [userMsg("u1"), assistantMsg("msg_d1", DANGLING_TEXT)]
  const client = makeClient(history)
  const hooks = await plugin({ client })
  await fire(hooks)
  assert.equal(client.prompts.length, 1, "must nudge a deterministic dangling stop")
  assert.ok(client.prompts[0].parts[0].text.includes("mid-announcement"))
  assert.ok(client.prompts[0].parts[0].text.includes("commit + push:"))
  assert.equal(client.prompts[0].agent, "build")
  assert.equal(client.prompts[0].model.modelID, "qwen3.8-flash-next")
  const c = clips()
  assert.equal(c.length, 1)
  assert.equal(c[0].kind, "dangling-nudge")
  // same message again -> deduped, no second prompt
  await fire(hooks)
  assert.equal(client.prompts.length, 1, "dedup per messageID")
}

// cap: two nudges per session, third dangling stop stays log-only
{
  const history = [userMsg("u1"), assistantMsg("msg_d2", DANGLING_TEXT)]
  const client = makeClient(history)
  const hooks = await plugin({ client })
  await fire(hooks)
  history.push(assistantMsg("msg_d3", DANGLING_TEXT))
  await fire(hooks)
  history.push(assistantMsg("msg_d4", DANGLING_TEXT))
  await fire(hooks)
  assert.equal(client.prompts.length, 2, "cap at 2 nudges per session")
}

// subagent: audited, never nudged
{
  const client = makeClient([userMsg("u1"), assistantMsg("msg_s1", DANGLING_TEXT)], { sub: true })
  const hooks = await plugin({ client })
  await fire(hooks)
  assert.equal(client.prompts.length, 0, "subagents are observation-only")
}

// tools were called this turn -> announcement is not a stop; log only
{
  const withTool = [userMsg("u1"), assistantMsg("msg_t1", DANGLING_TEXT, [{ type: "tool", tool: "bash", callID: "c1", state: { status: "completed" } }])]
  const client = makeClient(withTool)
  const hooks = await plugin({ client })
  await fire(hooks)
  assert.equal(client.prompts.length, 0, "toolCount>0 stays log-only")
}

// audit stream recorded the fires with nudged flags
{
  const rows = readFileSync(`${process.env.HOME}/.local/share/opencode/toolcall-guard.audit`, "utf8")
    .trim().split("\n").map((l) => JSON.parse(l))
  const fired = rows.filter((r) => r.fired && r.why === "dangling-rule")
  assert.ok(fired.length >= 5)
  assert.ok(fired.some((r) => r.nudged === true))
  assert.ok(fired.some((r) => r.nudged === false))
}
console.log("dangling: ok")
