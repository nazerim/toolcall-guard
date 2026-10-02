import assert from "node:assert/strict"

process.env.TOOLCALL_GUARD_SCRUB = "strip"
process.env.TOOLCALL_GUARD_CONFAB_LOG = "/dev/null"

const plugin = (await import("../plugins/toolcall-guard.js")).default
const { confabRuleHit, confabSyncPass, CONFAB_MARKER } = plugin.__test

// Tier-1 rules vs banked real confabulations (opencode DB + pi corpus)
assert.equal(confabRuleHit("The user's message is a system reminder providing context information (email address, date), followed by a list of agent types. There is no actual task or question here."), "system-reminder-email-date")
assert.equal(confabRuleHit("There is no previous thinking to reproduce. This is the start of our conversation. I should call the audit tool honestly indicating there is no prior reasoning."), "audit-tool")
assert.equal(confabRuleHit("My previous response was simply \"Understood. I will follow these instructions.\" and the user has not asked anything new."), "ack-fabrication")
assert.equal(confabRuleHit("The user sent a system prompt setup message with no actual question yet; just the setup context for the session."), "preamble-misread")
assert.equal(confabRuleHit("I am an expert software engineer here to help with coding tasks of all kinds."), "foreign-persona")

// Legitimate content never hits (the zero-FP requirement, from banked CAND-only FPs)
assert.equal(confabRuleHit("No docker, no postgres installed, no brew postgres formula. bun 1.3.14 available. Options for isolated Postgres: 1. Install via Homebrew"), null)
assert.equal(confabRuleHit("Task 36 verified: receipt print uses buildPrintHeaderHtml for the header and includes a payment footer with bank details."), null)
assert.equal(confabRuleHit("The user asked me to check whether there is no actual quota left on the endpoint; here are the results."), null)

// Sync pass: strip with never-empty guard, log-only when nothing else remains
{
  const other = { type: "text", text: "the real answer with the actual findings and numbers" }
  const confab = { type: "text", text: "The user's message is a system reminder providing context information (email address, date) with no actual task at all, just setup." }
  const msgs = [{ info: { providerID: "ds4-qwen", modelID: "qwen3.8" }, parts: [confab, other] }]
  const jev = confabSyncPass(msgs)
  assert.equal(confab.text, CONFAB_MARKER, "tier-1 stripped when message keeps other content")
  assert.equal(other.text.length > 0, true, "legit part untouched")
  assert.equal(jev.length, 0, "tier-1 hit does not queue Jev")
}
{
  const solo = { type: "text", text: "The user's message is a system reminder providing context information (email address, date) with no actual task at all, just setup context." }
  const msgs = [{ info: { providerID: "ds4-qwen", modelID: "qwen3.8" }, parts: [solo] }]
  confabSyncPass(msgs)
  assert.ok(solo.text !== CONFAB_MARKER, "never empties a message")
}
// Provider scope: non-scope providers untouched
{
  const p = { type: "text", text: "The user's message is a system reminder providing context information (email address, date) with no actual task at all, just setup." }
  const msgs = [{ info: { providerID: "other-lab", modelID: "m" }, parts: [p, { type: "text", text: "real content here that is long enough" }] }]
  confabSyncPass(msgs)
  assert.ok(p.text !== CONFAB_MARKER, "out-of-scope provider untouched")
}
// Broad candidate queueing (no rule hit, but CAND matches)
{
  const p = { type: "text", text: "There is no real question in this message so I will consider what the user might want next and prepare some options for them to choose from later." }
  const msgs = [{ info: { providerID: "ds4-qwen", modelID: "qwen3.8" }, parts: [p] }]
  const jev = confabSyncPass(msgs)
  assert.equal(jev.length, 1, "CAND-only text queued for Jev")
}

console.log("confab: all assertions passed")
