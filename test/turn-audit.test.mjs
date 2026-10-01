import assert from "node:assert/strict"
import plugin from "../plugins/toolcall-guard.js"

const { analyzeAudit, auditBody, sieveStage, AUDIT_Q } = plugin.__test

const user = (text) => ({ info: { role: "user", id: "u1" }, parts: [{ type: "text", text }] })
const asst = (id, opts = {}) => ({
  info: { role: "assistant", id, providerID: "p", modelID: "m", ...(opts.info || {}) },
  parts: [
    ...(opts.parts || [{ type: "text", text: opts.text || "Here is the summary of the analysis." }]),
    ...(opts.noFinish ? [] : [{ type: "step-finish" }]),
  ],
})

// --- sieveStage: deterministic exits ---------------------------------------
assert.equal(sieveStage("Should I apply the patch to server.py?"), "question")
assert.equal(sieveStage("All set — ready for the PR whenever you want it."), "offer")
assert.equal(sieveStage("Say the word and I'll land it."), "offer")
assert.equal(sieveStage("Here's the state of play:"), "dangling")
assert.equal(sieveStage("Remaining steps:\n- fit\n- refit"), "dangling")
assert.equal(sieveStage("Two lanes remain\n- the fast path\n- the slow path"), "residue")
assert.equal(sieveStage("The refactor is complete and all 14 tests pass."), "residue")

// --- analyzeAudit: null cases ----------------------------------------------
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

// --- analyzeAudit: happy path — request, tail, ledger ----------------------
{
  const msgs = [
    user("update the README with the plan"),
    asst("a0", { parts: [{ type: "text", text: "working" }, { type: "tool" }, { type: "tool" }] }),
    asst("a1", { text: "The README now contains the full calibration plan." }),
  ]
  const a = analyzeAudit(msgs)
  assert.ok(a)
  assert.equal(a.messageID, "a1")
  assert.equal(a.request, "update the README with the plan")
  assert.equal(a.toolCount, 2, "turn ledger counts earlier tool parts")
  assert.equal(a.model.providerID, "p")
}

// --- auditBody: single whose-move choice (W2b), live wire shape ------------
{
  const body = auditBody({ request: "R", tail: "T" })
  assert.equal(body.model, "rizzo-flow-1.7b-q8_0")
  assert.deepEqual(body.state, { user_request: "R", assistant_final: "T" })
  const q = body.questions.q
  assert.equal(q.type, "choice")
  assert.match(q.instructions, /whose move is next/)
  assert.deepEqual(Object.keys(q.criteria), ["assistant", "user", "nobody"])
  assert.match(q.criteria.assistant, /Now I will/)
  assert.match(q.criteria.assistant, /lists work that remains undone/)
  assert.match(q.criteria.user, /shall I/)
  assert.deepEqual(Object.keys(q).sort(), ["criteria", "instructions", "type"])
}

console.log("turn-audit v4: all assertions passed")
