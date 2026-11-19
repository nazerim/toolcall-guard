import { createHash } from "node:crypto"
import { appendFileSync } from "node:fs"
import { join } from "node:path"

// V2 is opt-in: log and 1 score residue at .5; overnight uses .6.
// Scores are observations in every mode. Only 1/overnight + DANGLING=nudge
// can submit a prompt, and only for the deterministic zero-tool rule.
// Sending request/reply text to the classifier needs a second opt-in,
// TOOLCALL_GUARD_AUDIT_SEND=1 (as confab's SCRUB_JEV=1). Without it the lane
// only logs local rule-based observations and never touches the network.
// RIZZO may select a numeric-loopback HTTP(S) endpoint (as confab): no
// localhost/DNS, query, fragment, credentials or redirects; reply <= 16 KB.
// Only the latest visible request prefix and reply tail go to the classifier.
// Child turns get local observations only (no classifier text or prompts).
const completion = "session.execution.succeeded"
const maxAge = 10_000
const maxSessions = 2000
// Idle sessions are evicted (budgets reset) rather than refusing new ones.
const idleMs = 6 * 60 * 60 * 1000
const maxBody = 16_384
const maxObservations = 100
const maxScores = 15
const maxNudges = 2
const nudgeText = "[toolcall-guard turn audit] Your previous reply ended with an unfinished announcement. If the current request still requires the announced action and it is authorized, continue; otherwise state what remains or whose move is next."
// Own and core auto-continue nudges: replies to them are not scored.
const ownNudge = /^\[toolcall-guard (?:auto-continue|turn audit)\] /
const states = new Map()
export const __test = { states, maxSessions, idleMs }
let scoring = false
let retryAfter = 0

const unwrap = (raw) => raw?.data ?? raw
// At f870161 the Promise plugin adapter drops requestOptions, so a signal
// passed to ctx.session.* is advisory. Race it to enforce the deadline.
const bounded = (promise, signal) => signal.aborted ? Promise.reject(signal.reason) :
  new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason)
    signal.addEventListener("abort", stop, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", stop))
  })
const validID = (id, prefix) =>
  typeof id === "string" && id.startsWith(prefix) && /^[A-Za-z0-9_-]{5,128}$/.test(id)

// Mirrors confab.js localEndpoint: numeric loopback only.
function loopback(raw) {
  try {
    const url = new URL(raw)
    if (["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "[::1]"].includes(url.hostname) &&
        !url.username && !url.password && !url.search && !url.hash) return url
  } catch {}
}

// Mirrors confab.js readScore: refuse classifier replies over 16 KB.
async function readScore(response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error("HTTP failure")
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0, json = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBody) {
        await reader.cancel()
        throw new Error("oversized reply")
      }
      json += decoder.decode(value, { stream: true })
    }
    return JSON.parse(json + decoder.decode())?.answers?.q?.probabilities?.assistant
  } finally {
    reader.releaseLock()
  }
}

// Drop sessions idle past idleMs; states is kept in last-touched order.
function evictIdle(now) {
  for (const [key, state] of states) {
    if (now - state.seen < idleMs) break
    states.delete(key)
  }
}

function candidate(raw, event, clipKind) {
  const messages = unwrap(raw)
  if (!Array.isArray(messages)) return
  // The succeeded event has no messageID. At f870161, the corresponding
  // durable idle marker (msg_ derived from evt_) is in session.context.
  // Refuse stale events rather than guessing at the latest assistant.
  const idle = messages.at(-1)
  if (idle?.type !== "idle" || idle.outcome !== "succeeded" ||
      idle.id !== event.id.replace(/^evt_/, "msg_")) return
  const last = messages.at(-2)
  if (last?.type !== "assistant" || !validID(last.id, "msg_") ||
      last.finish !== "stop" || last.error || last.retry ||
      ["title", "summary", "compaction"].includes(last.agent) ||
      !Array.isArray(last.content) || last.content.some((p) => p?.type === "tool")) return
  const text = last.content.filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text).join("")
  if (clipKind(text)) return
  let request, toolCount = 0
  for (let i = messages.length - 3; i >= 0; i--) {
    const m = messages[i]
    if (["idle", "compaction", "synthetic", "shell"].includes(m?.type)) break
    if (m?.type === "assistant") toolCount += m.content?.filter((p) => p?.type === "tool").length ?? 0
    if (request === undefined && m?.type === "user") request = m.text
  }
  if (typeof request !== "string" || !request.trim() || ownNudge.test(request)) return
  return { id: last.id, request: request.slice(0, 1200), tail: text.slice(-800), toolCount }
}

export async function setupAudit(ctx, { clipKind, sieveStage, AUDIT_Q, DATA_DIR }) {
  const env = process.env
  const mode = env.TOOLCALL_GUARD_AUDIT?.toLowerCase()
  if (env.TOOLCALL_GUARD?.toLowerCase() === "off" || !["1", "log", "overnight"].includes(mode)) return
  const mayNudge = mode !== "log" && env.TOOLCALL_GUARD_DANGLING?.toLowerCase() === "nudge"
  const value = Number(env.TOOLCALL_GUARD_AUDIT_T?.trim() || NaN)
  const threshold = value >= 0 && value <= 1 ? value : mode === "overnight" ? 0.6 : 0.5
  const url = env.TOOLCALL_GUARD_AUDIT_SEND === "1" &&
    loopback(env.TOOLCALL_GUARD_RIZZO || "http://127.0.0.1:8017/v1/systemone")
  const model = env.TOOLCALL_GUARD_RIZZO_MODEL || "rizzo-flow-1.7b-q8_0"
  const controller = new AbortController()
  const dir = DATA_DIR()
  const owns = (info, id) => info?.id === id && info?.outcome === "succeeded" &&
    !!ctx.location?.directory && info.location?.directory === ctx.location.directory
  let capLogged = false
  const log = (stage, child, fields) => {
    try {
      appendFileSync(join(dir, "toolcall-guard.audit"),
        JSON.stringify({ v: 4, at: new Date().toISOString(), mode, stage, child, ...fields }) + "\n", { mode: 0o600 })
    } catch {}
  }

  const handle = async (event) => {
    const sessionID = event?.data?.sessionID
    const age = Date.now() - event?.created
    if (event?.type !== completion || !validID(event.id, "evt_") ||
        !validID(sessionID, "ses_") || !(age >= 0 && age < maxAge)) return
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(maxAge - age)])
    const args = { sessionID }
    const opts = { signal }
    const key = JSON.stringify([dir, sessionID])
    let state = states.get(key)
    if (state?.events.has(event.id) || state?.events.size >= maxObservations) return
    const info = unwrap(await bounded(ctx.session.get(args, opts), signal))
    if (signal.aborted || !owns(info, sessionID)) return
    const a = candidate(await bounded(ctx.session.context(args, opts), signal), event, clipKind)
    if (signal.aborted || !a) return
    const now = Date.now()
    evictIdle(now)
    state = states.get(key)
    if (state) states.delete(key)
    else if (states.size >= maxSessions) {
      // Every tracked session is active: skip rather than evict live budgets.
      if (!capLogged) log("skipped", !!info.parentID, { reason: "session-cap" })
      capLogged = true
      return
    } else {
      capLogged = false
      state = { events: new Set(), scores: 0, nudges: 0 }
    }
    state.seen = now
    states.set(key, state)
    if (state.events.has(event.id) || state.events.size >= maxObservations) return
    state.events.add(event.id)
    const child = !!info.parentID
    const stage = sieveStage(a.tail)
    if (stage === "dangling") {
      let nudged = false
      try {
        if (mayNudge && !child && a.toolCount === 0 && state.nudges < maxNudges) {
          const current = unwrap(await bounded(ctx.session.get(args, opts), signal))
          const latest = candidate(await bounded(ctx.session.context(args, opts), signal), event, clipKind)
          if (!signal.aborted && owns(current, sessionID) && !current.parentID &&
              !current.revert && !current.time?.archived && latest?.id === a.id) {
            const hash = createHash("sha256").update(`${sessionID}:${a.id}`).digest("hex")
            // Strict claim: if another plugin instance claimed it, or the
            // filesystem is unavailable, skip recovery rather than duplicate.
            appendFileSync(join(dir, `toolcall-guard.audit-nudge.${hash}`), "", { flag: "wx", mode: 0o600 })
            state.nudges++
            // V2 resolves the current session agent/model; prompt has no
            // per-call overrides. Never steer an already running turn.
            await bounded(ctx.session.prompt({
              sessionID, id: `msg_${hash}`, delivery: "queue",
              text: nudgeText,
            }, opts), signal)
            nudged = true
          }
        }
      } catch {}
      log(stage, child, { fired: true, nudged })
      return
    }
    // Without the send opt-in, residue is a local observation only.
    if (stage !== "residue" || child || !url) {
      log(stage, child, { fired: false })
      return
    }
    if (scoring || Date.now() < retryAfter || state.scores >= maxScores) return
    scoring = true
    state.scores++
    try {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(4000)])
      const response = await fetch(url, {
        method: "POST", redirect: "error", credentials: "omit", signal: deadline,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, state: { user_request: a.request, assistant_final: a.tail }, questions: AUDIT_Q }),
      })
      const p = await readScore(response)
      if (deadline.aborted) return
      if (typeof p !== "number" || !(p >= 0 && p <= 1)) throw new Error("invalid score")
      log(stage, child, { p, fired: p > threshold })
    } catch {
      if (!controller.signal.aborted) {
        retryAfter = Date.now() + 60_000
        log(stage, child, { error: "classifier-unavailable" })
      }
    } finally {
      scoring = false
    }
  }

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ types: [completion], signal: controller.signal })) {
        if (controller.signal.aborted) break
        try { await handle(event) } catch { /* The lane never blocks the session. */ }
      }
    } catch { /* Subscription failure must not affect other plugin lanes. */ }
  })()
  return () => controller.abort()
}
