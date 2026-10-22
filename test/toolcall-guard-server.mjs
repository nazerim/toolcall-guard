import http from "node:http"

const PORT = Number(process.env.PORT || 8787)
const SCENARIO = process.env.SCENARIO || "late"

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

// opening fragment: id present, function.name NULL (exactly what the token-plan
// endpoint sends when its parser misfires on backtick text in reasoning)
const makeLATE = (tool) => [
  { choices: [{ index: 0, delta: { reasoning_content: "I should run `echo` via the bash tool." } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: null, arguments: '{"com' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'mand":"ec' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ho GUARD_OK"}' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: tool } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
]

// name never arrives at all -> the phantom call must be dropped
const DROP = [
  { choices: [{ index: 0, delta: { content: "Let me think about this. " } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: null, arguments: '{"ghost":' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"boo"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]

// built by concatenation so this file never contains the raw pattern itself
const POISON_TOK = "<" + "|" + "im_end" + "|" + ">"

// turn 1: poisoned reasoning + a WELL-FORMED tool call (so the session
// continues to turn 2, where opencode replays history — the scrubber must
// neutralize the token on the wire)
const makePOISON = (tool) => [
  { choices: [{ index: 0, delta: { reasoning_content: "closing marker " + POISON_TOK + " seen" } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: tool, arguments: '{"command":"echo POISON_OK"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
]

// mode-3a signature: clean stop, no tool call, text ends on a dangling backtick
const CLIP = [
  { choices: [{ index: 0, delta: { reasoning_content: "listing the steps" } }] },
  { choices: [{ index: 0, delta: { content: "Here is the plan: first, open the config and set `" } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]

const OK_TEXT = [
  { choices: [{ index: 0, delta: { content: "ALL_DONE" } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]

http
  .createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      if (req.url && req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({ object: "list", data: [{ id: "guardtest-model", object: "model" }] }))
      }
      if (!req.url || !req.url.endsWith("/chat/completions")) {
        res.writeHead(404)
        return res.end()
      }
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = {}
      }
      const dump = process.env.GUARDTEST_REQS || "reqs.jsonl"
      import("node:fs").then((fs) => fs.appendFileSync(dump, body + "\n"))
      if (process.env.GUARDTEST_VERBOSE) {
        const blob0 = JSON.stringify(parsed.messages || [])
        console.error(
          `[req] url=${req.url} stream=${parsed.stream} msgs=${(parsed.messages || []).length}` +
            ` marker=${blob0.includes("MARKER7788")} toolResult=${(parsed.messages || []).some((m) => m && m.role === "tool")}` +
            ` nudged=${blob0.includes("Resume exactly where you stopped")} tools=${(parsed.tools || []).length}`,
        )
      }
      if (parsed.stream === false) {
        if (process.env.GUARDTEST_VERBOSE) console.error("[resp] NON-STREAM branch -> static ALL_DONE")
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(
          JSON.stringify({
            id: "cmpl",
            object: "chat.completion",
            created: 1,
            model: "guardtest-model",
            choices: [{ index: 0, message: { role: "assistant", content: "ALL_DONE" }, finish_reason: "stop" }],
          }),
        )
      }
      const blob = JSON.stringify(parsed.messages || [])
      // isMain must NOT match the title-generation request: V2 issues a title
      // call whose prompt embeds the raw user text (marker included, and the
      // user content is identical to the primary's). Discriminator: the
      // agent-loop request carries tools; the title request has none.
      const isMain = (parsed.tools || []).length > 0 && blob.includes("MARKER7788")
      // V2's CLI wraps the run message in literal quotes inside the user
      // text, so the bare "auto-continue" substring would also match the
      // user prompt once the nudge text is replayed. The nudge's resume
      // instruction is the unambiguous marker; tool-role messages are the
      // tool-result marker.
      const hasToolResult = (parsed.messages || []).some((m) => m && m.role === "tool")
      const wasNudged = blob.includes("Resume exactly where you stopped")
      // V2 renamed the bash tool to shell — call whichever the harness offers
      const toolNames = (parsed.tools || []).map((t) => (t.function && t.function.name) || t.name)
      const shellTool = toolNames.includes("shell") ? "shell" : "bash"
      const events =
        isMain && !hasToolResult && !wasNudged
          ? SCENARIO === "drop"
            ? DROP
            : SCENARIO === "poison"
              ? makePOISON(shellTool)
              : SCENARIO === "clip"
                ? CLIP
                : makeLATE(shellTool)
          : OK_TEXT
      if (process.env.GUARDTEST_VERBOSE) console.error(`[resp] scenario=${SCENARIO} serving ${events.length} events (${isMain ? "main" : "other"}${hasToolResult ? "+toolResult" : ""}${wasNudged ? "+nudged" : ""})`)
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
      for (const e of events) sse(res, { id: "cmpl", object: "chat.completion.chunk", created: 1, model: "guardtest-model", ...e })
      res.write("data: [DONE]\n\n")
      res.end()
    })
  })
  .listen(PORT, "127.0.0.1", () => console.log(`guard server on ${PORT} scenario=${SCENARIO}`))
