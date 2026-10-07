import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import plugin from "../plugins/toolcall-guard.js"

const { subreportIssue, annotateSubreports } = plugin.__test
const LOG = "/tmp/toolcall-guard-subreport.test.log"
if (existsSync(LOG)) writeFileSync(LOG, "")
process.env.TOOLCALL_GUARD_SUBREPORT_LOG = LOG

const EMPTY = '<task id="ses_eea636e0bffeWA9lv7BKCb2j8e" state="completed">\n<task_result>\n\n</task_result>\n</task>'
const OK = '<task id="ses_x" state="completed">\n<task_result>\nShipped: 4 commits, tests green, handover updated with the numbers.\n</task_result>\n</task>'
const CLIPPED = '<task id="ses_y" state="completed">\n<task_result>\nDone — the fix lives in `kernel_qwen4_attn_mm` staging; next wire `</task_result>\n</task>'

// --- subreportIssue ----------------------------------------------------------
assert.deepEqual(subreportIssue(EMPTY), { task: "ses_eea636e0bffeWA9lv7BKCb2j8e", kind: "empty-report" })
assert.equal(subreportIssue(OK), null)
assert.equal(subreportIssue(CLIPPED).kind, "clipped-report")
assert.equal(subreportIssue("no task wrapper here"), null)

// --- annotateSubreports: default mode logs, never mutates ---------------------
{
  const msgs = [{ info: { id: "m1", role: "assistant" }, parts: [
    { id: "p1", type: "tool", tool: "task", state: { status: "completed", output: EMPTY, input: { description: "P1b.5 tensorize" } } },
    { id: "p2", type: "tool", tool: "task", state: { status: "completed", output: OK } },
    { id: "p3", type: "tool", tool: "bash", state: { status: "completed", output: "" } },
    { id: "p4", type: "tool", tool: "task", state: { status: "running", output: "" } },
  ] }]
  const stats = {}
  annotateSubreports(msgs, stats)
  assert.equal(stats.subreport, 1)
  assert.equal(msgs[0].parts[0].state.output, EMPTY)
  annotateSubreports(msgs, stats)
  assert.equal(stats.subreport, 1)
  const lines = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean)
  assert.equal(lines.length, 1)
  const row = JSON.parse(lines[0])
  assert.equal(row.kind, "empty-report")
  assert.equal(row.mode, "log")
  assert.ok(row.task.startsWith("ses_eea636"))
}

// --- annotate mode appends the affordance (subprocess: mode resolves at load) --
{
  const MOD = JSON.stringify(fileURLToPath(new URL("../plugins/toolcall-guard.js", import.meta.url)))
  const probe = `
    import plugin from ${MOD}
    const { annotateSubreports } = plugin.__test
    const msgs = [{ info: { id: "m1", role: "assistant" }, parts: [{ id: "px", type: "tool", tool: "task",
      state: { status: "completed", output: ${JSON.stringify(EMPTY)} } }] }]
    annotateSubreports(msgs, {})
    annotateSubreports(msgs, {})
    const out = msgs[0].parts[0].state.output
    const n = (out.match(/\\[toolcall-guard subreport/g) || []).length
    console.log(JSON.stringify([n, out.includes('task="ses_eea636e0bffeWA9lv7BKCb2j8e"'), out.includes("EMPTY")]))
  `
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    env: { ...process.env, TOOLCALL_GUARD_SUBREPORT: "annotate" },
    encoding: "utf8",
  })
  assert.deepEqual(JSON.parse(r.stdout.trim()), [1, true, true])
}
