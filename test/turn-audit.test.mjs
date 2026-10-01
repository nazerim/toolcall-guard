import assert from "node:assert/strict"
import plugin from "../plugins/toolcall-guard.js"

const { analyzeAudit, auditBody, vetoRule, AUDIT_Q } = plugin.__test

const user = (text) => ({ info: { role: "user", id: "u1" }, parts: [{ type: "text", text }] })
const asst = (id, opts = {}) => ({
  info: { role: "assistant", id, providerID: "p", modelID: "m", ...(opts.info || {}) },
  parts: opts.parts || [{ type: "text", text: opts.text || "Here is the summary of the analysis." }],
})

// analyzeAudit: null cases
assert.equal(analyzeAudit([]), null)
assert.equal(analyzeAudit([user("hi")]), null, "no assistant turn")
assert.equal(
  analyzeAudit([user("q"), asst("a1", { parts: [{ type: "tool" }, { type: "text", text: "did work" }] })]),
  null,
  "final message with tool part is not auditable",
)
assert.equal(analyzeAudit([user("q"), asst("a1", { text: "cut off with a backtick `" })]), null, "clip lane owns clips")
assert.equal(analyzeAudit([user("q"), asst("a1", { text: "   " })]), null, "empty text")
assert.equal(
  analyzeAudit([user("q"), asst("a1", { info: { agent: "title" }, text: "some title work" })]),
  null,
  "meta agents skipped",
)
assert.equal(analyzeAudit([user("q"), asst("a1", { info: { error: { name: "X" } }, text: "err" })]), null, "errors skipped")

// analyzeAudit: happy path — request, tail, ledger
{
  const toolPart = { type: "tool" }
  const msgs = [
    user("update the README with the plan"),
    asst("a0", { parts: [{ type: "text", text: "working" }, toolPart, toolPart] }),
    asst("a1", { text: "Now I will add the calibration section next." }),
  ]
  const a = analyzeAudit(msgs)
  assert.ok(a)
  assert.equal(a.messageID, "a1")
  assert.equal(a.request, "update the README with the plan")
  assert.ok(a.tail.endsWith("calibration section next."), "tail is final text")
  assert.equal(a.toolCount, 2, "turn ledger counts earlier tool parts")
  assert.equal(a.model.providerID, "p")
}

// auditBody shape matches rizzo /v1/systemone schema (noul = {type,instructions})
{
  const body = auditBody({ request: "R", tail: "T" })
  assert.equal(body.model, "rizzo-flow-1.7b-q8_0")
  assert.deepEqual(body.state, { user_request: "R", assistant_final: "T" })
  for (const k of ["done", "asks", "promises"]) {
    assert.equal(body.questions[k].type, "noul")
    assert.equal(typeof body.questions[k].instructions, "string")
    assert.equal(Object.keys(body.questions[k]).sort().join(","), "instructions,type")
  }
  assert.equal(Object.keys(AUDIT_Q).sort().join(","), "asks,done,promises")
}

// vetoRule: asks is a suppressor gate, not a voter
const th = { asks: 0.7, prom: 0.5, done: 0.7 }
assert.deepEqual(vetoRule({ asks: 0.85, promises: 0.9, done: 0.1 }, th), { fired: false, why: "suppressed-asks" })
assert.deepEqual(vetoRule({ asks: 0.69, promises: 0.51, done: 0.9 }, th), { fired: true, why: "promises" })
assert.deepEqual(vetoRule({ asks: 0.69, promises: 0.5, done: 0.69 }, th), { fired: true, why: "not-done" })
assert.deepEqual(vetoRule({ asks: 0.69, promises: 0.5, done: 0.7 }, th), { fired: false, why: "below-thresholds" })
// overnight mode: looser promises activator only
assert.deepEqual(vetoRule({ asks: 0.5, promises: 0.35, done: 0.8 }, { asks: 0.7, prom: 0.3, done: 0.7 }), {
  fired: true,
  why: "promises",
})

console.log("turn-audit: all assertions passed")
