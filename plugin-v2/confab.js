import { createHash } from "node:crypto"
import { appendFileSync } from "node:fs"
import { join } from "node:path"

const candidate = /(no\s+(actual\s+|real\s+)?(question|task)|no previous thinking|no prior reasoning|readiness to help|is a system reminder|just the setup context|no substantive content)/i
const questions = {
  q: {
    type: "noul",
    instructions: "Is this passage the assistant narrating its guess about the conversation itself — describing the incoming message as containing no task or question, or claiming no previous thinking exists — instead of doing actual work for the user?",
  },
}
const maxText = 8192
const maxSeen = 2000
const intervalMs = 10_000

function localEndpoint(raw) {
  try {
    const url = new URL(raw || "http://127.0.0.1:8017/v1/systemone")
    // Numeric loopback only: no redirects, DNS, URL credentials, or query tokens.
    if (["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "[::1]"].includes(url.hostname) &&
        !url.username && !url.password && !url.search && !url.hash) return url
  } catch {}
}

async function readScore(response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    return
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0, json = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 16_384) {
        await reader.cancel()
        return
      }
      json += decoder.decode(value, { stream: true })
    }
    const score = JSON.parse(json + decoder.decode())?.answers?.q?.noul
    if (Number.isFinite(score) && score >= 0 && score <= 1) return score
  } finally {
    reader.releaseLock()
  }
}

const plainReasoning = (p) => p.type === "reasoning" &&
  p.encrypted === undefined && p.providerMetadata === undefined &&
  p.metadata === undefined && p.cache === undefined

const retainedContent = (p) => p && (
  ((p.type === "text" || p.type === "reasoning") && typeof p.text === "string" &&
    p.text.length <= maxText && /\S/.test(p.text)) ||
  (p.type === "tool-call" && typeof p.id === "string" && !!p.id && typeof p.name === "string" && !!p.name)
)

export async function setupConfab(ctx, { DATA_DIR, confabRuleHit }) {
  const mode = process.env.TOOLCALL_GUARD_SCRUB?.toLowerCase()
  if (process.env.TOOLCALL_GUARD?.toLowerCase() === "off" || !["1", "log", "strip"].includes(mode)) return
  let scope
  try {
    scope = new RegExp(process.env.TOOLCALL_GUARD_SCRUB_PROVIDERS || "qwen|ds4", "i")
  } catch {
    return
  }

  // Sending readable reasoning to a separate process requires a second opt-in.
  const endpoint = process.env.TOOLCALL_GUARD_SCRUB_JEV === "1" &&
    localEndpoint(process.env.TOOLCALL_GUARD_RIZZO)
  const model = process.env.TOOLCALL_GUARD_RIZZO_MODEL || "rizzo-flow-1.7b-q8_0"
  const logPath = process.env.TOOLCALL_GUARD_CONFAB_LOG || join(DATA_DIR(), "toolcall-guard.confab")
  const seen = new Set()
  let closed = false, pending, lastStart = -Infinity
  const log = (record) => {
    try {
      appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), mode, ...record }) + "\n", { mode: 0o600 })
    } catch {}
  }
  const first = (key) => {
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > maxSeen) seen.delete(seen.values().next().value)
    return true
  }
  const classify = async (passage) => {
    const controller = new AbortController()
    pending = controller
    lastStart = performance.now()
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
        body: JSON.stringify({ model, state: { passage: passage.slice(0, 1500) }, questions }),
      })
      const score = await readScore(res)
      if (!closed && score !== undefined) {
        log({ tier: 2, verdict: score > 0.65 ? "confab-candidate" : "likely-legit" })
      }
    } catch {
      // Classifier unavailability or malformed output never affects dispatch.
    } finally {
      pending = undefined
    }
  }

  const registration = await ctx.session.hook("context", (event) => {
    try {
      // The lowered history has roles but no per-message source model.
      // Scope to the destination model on the primary request.
      const { model, messages } = event
      if (closed || typeof model?.providerID !== "string" || !model.providerID ||
          typeof model.id !== "string" || !model.id || !Array.isArray(messages)) return
      const target = `${model.providerID}/${model.id}`
      if (target.length > 512 || !scope.test(target)) return
      let budget = 256
      for (let i = messages.length - 1; i >= Math.max(0, messages.length - 128) && budget > 0; i--) {
        const message = messages[i]
        const parts = message?.content
        if (message?.role !== "assistant" || !Array.isArray(parts) || parts.length > budget) continue
        budget -= parts.length
        const hits = new Set(), records = []
        for (const [j, part] of parts.entries()) {
          if (!part || (part.type !== "text" && !plainReasoning(part)) ||
              typeof part.text !== "string" || part.text.length < 40 || part.text.length > maxText) continue
          const rule = confabRuleHit(part.text)
          const key = () => createHash("sha256").update(JSON.stringify([
            event.sessionID?.slice(0, 128), target, message.id?.slice(0, 128), j, part.type, part.text,
          ])).digest("hex")
          if (rule) {
            if (mode === "strip" && part.type === "reasoning") hits.add(j)
            if (first(key())) records.push({ j, rule, part: part.type })
          } else if (endpoint && !pending && performance.now() - lastStart >= intervalMs &&
                     part.type === "reasoning" && candidate.test(part.text) && first(key())) {
            void classify(part.text)
          }
        }
        // Check all removals together and copy the outbound message, not the
        // underlying parts. Dedup controls observations, never future strips.
        const strip = hits.size > 0 && parts.some((p, j) => !hits.has(j) && retainedContent(p))
        if (strip) messages[i] = { ...message, content: parts.filter((_, j) => !hits.has(j)) }
        for (const { j, ...record } of records) log({ tier: 1, ...record, stripped: strip && hits.has(j) })
      }
    } catch {
      // Malformed hook data is not a reason to break the model request.
    }
  })
  return async () => {
    closed = true
    pending?.abort()
    await registration?.dispose()
  }
}
