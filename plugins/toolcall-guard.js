// toolcall-guard.js — global opencode plugin
//
// Graceful handling of malformed streaming tool calls from OpenAI-compatible
// providers (observed: Qwen token-plan endpoint, qwen3.8-flash / qwen3.8-max).
//
// Root cause: the bundled @ai-sdk/openai-compatible stream handler throws
// AI_InvalidResponseDataError ("Expected 'function.name' to be a string." /
// "Expected 'id' to be a string.") whenever a NEW tool_calls delta lacks a
// usable id/name. The token-plan server sometimes emits name:null on the
// opening fragment — typically right after the model writes tool-call-like
// text (backticks, quotes) in its reasoning and the server-side parser
// misfires — or splits id/name/arguments across fragments. The throw aborts
// the whole turn.
//
// Fix: wrap each @ai-sdk/openai-compatible provider's fetch (opencode's
// provider loader explicitly honors options.fetch when it is a function) and
// pipe the SSE body through a guard:
//   - fragments for an unknown tool-call index are buffered until both id and
//     a non-empty name are known, then emitted as one valid opening fragment
//     (with the accumulated arguments);
//   - names are trimmed of surrounding whitespace and backticks;
//   - calls that never resolve by finish_reason are dropped — the turn ends
//     as plain text and the session survives;
//   - well-formed streams pass through byte-identical.

import { appendFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const cleanName = (v) => (typeof v === "string" ? v.replace(/^[\s`]+|[\s`]+$/g, "") : "")

// Local ISO stamp WITH offset (operator lives in UTC+8; bare toISOString()
// is UTC and has caused repeated misreads of soak timestamps).
const nowStamp = () => {
  const d = new Date()
  const off = -d.getTimezoneOffset()
  const p = (n) => String(n).padStart(2, "0")
  const sign = off >= 0 ? "+" : "-"
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  )
}

const strId = (v) => {
  if (typeof v === "string") return v === "" ? undefined : v
  if (typeof v === "number") return String(v)
  return undefined
}

const newState = () => ({
  line: "",
  calls: new Map(),
  nextIdx: 0,
  lastPending: -1,
  closed: false,
})

function processToolCalls(st, ev) {
  let touched = false
  const choices = Array.isArray(ev && ev.choices) ? ev.choices : []
  for (const c of choices) {
    if (!c || typeof c !== "object") continue
    if (c.finish_reason != null) st.closed = true
    const d = c.delta
    if (!d || !Array.isArray(d.tool_calls) || d.tool_calls.length === 0) continue
    const keep = []
    for (const tc of d.tool_calls) {
      if (!tc || typeof tc !== "object") {
        touched = true
        continue
      }
      let idx
      if (typeof tc.index === "number") {
        idx = tc.index
        if (idx >= st.nextIdx) st.nextIdx = idx + 1
      } else if (st.lastPending >= 0) {
        idx = st.lastPending
      } else {
        idx = st.nextIdx++
      }
      let s = st.calls.get(idx)
      if (s && s.open) {
        keep.push(tc)
        continue
      }
      const fn = tc.function
      const id0 = strId(tc.id)
      const nm0 = cleanName(fn && fn.name)
      if (!s && id0 && nm0 && id0 === tc.id && fn && nm0 === fn.name) {
        st.calls.set(idx, {
          id: id0,
          name: nm0,
          args: fn && typeof fn.arguments === "string" ? fn.arguments : "",
          open: true,
        })
        keep.push(tc)
        continue
      }
      if (!s) {
        s = { id: undefined, name: "", args: "", open: false }
        st.calls.set(idx, s)
      }
      if (id0 && !s.id) s.id = id0
      if (nm0 && !s.name) s.name = nm0
      if (fn && typeof fn.arguments === "string") s.args += fn.arguments
      if (s.id && s.name) {
        s.open = true
        if (st.lastPending === idx) st.lastPending = -1
        keep.push({ index: idx, id: s.id, function: { name: s.name, arguments: s.args } })
        touched = true
      } else {
        if (!st.closed) st.lastPending = idx
        touched = true
      }
    }
    if (touched) d.tool_calls = keep
  }
  return touched
}

function handleLine(st, line, emit) {
  if (!line.startsWith("data:")) {
    emit(line + "\n")
    return
  }
  const payload = line.slice(5).trim()
  if (payload === "" || payload === "[DONE]") {
    emit(line + "\n")
    return
  }
  let ev
  try {
    ev = JSON.parse(payload)
  } catch {
    emit(line + "\n")
    return
  }
  if (!processToolCalls(st, ev)) {
    emit(line + "\n")
    return
  }
  emit("data: " + JSON.stringify(ev) + "\n")
}

// Guard-liveness: the config hook only works if the provider loader honors
// options.fetch AND provider calls use globalThis.fetch. A runtime rewrite
// (e.g. OpenCode 2.0's Effect plumbing) could bypass both silently — the
// guard would become a no-op with zero errors. Cross-check: messages.transform
// proves a model call happened; guarded fetch proves the guard SAW it. Calls
// without any interception past a threshold = loud log-only warning.
const LIVE = { requests: 0, chatReq: 0, streams: 0, wrapped: 0, warned: false }
const LIVENESS_MIN = 25
const LIVENESS_LOG = () => process.env.TOOLCALL_GUARD_LIVENESS_LOG || null
function checkLiveness() {
  if (LIVE.warned || LIVE.wrapped === 0 || LIVE.requests < LIVENESS_MIN || LIVE.streams > 0) return
  LIVE.warned = true
  const line = JSON.stringify({
    at: nowStamp(),
    kind: "guard-liveness",
    err: "guard registered but zero SSE streams intercepted across " + LIVE.requests + " model calls — provider path may bypass options.fetch (runtime rewrite?)",
    requests: LIVE.requests,
    chatReq: LIVE.chatReq,
    wrapped: LIVE.wrapped,
  })
  try {
    const p = LIVENESS_LOG() || join(homedir(), ".local", "share", "opencode", "toolcall-guard.errors")
    appendFileSync(p, line + "\n")
  } catch {}
}

function makeGuard(baseFetch) {
  return async function guardedFetch(input, init) {
    const res = await baseFetch(input, init)
    try {
      const url = typeof input === "string" ? input : (input && input.url) || ""
      const ct = (res.headers && res.headers.get("content-type")) || ""
      if (url.includes("/chat/completions")) LIVE.chatReq++
      if (!res.ok || !res.body || !url.includes("/chat/completions") || !ct.includes("text/event-stream")) {
        checkLiveness()
        return res
      }
      LIVE.streams++
      const st = newState()
      const td = new TextDecoder()
      const te = new TextEncoder()
      const guarded = res.body.pipeThrough(
        new TransformStream({
          transform(bytes, controller) {
            const emit = (s) => controller.enqueue(te.encode(s))
            st.line += td.decode(bytes, { stream: true })
            let cut = st.line.indexOf("\n")
            while (cut >= 0) {
              const line = st.line.slice(0, cut)
              st.line = st.line.slice(cut + 1)
              handleLine(st, line, emit)
              cut = st.line.indexOf("\n")
            }
          },
          flush(controller) {
            const emit = (s) => controller.enqueue(te.encode(s))
            st.line += td.decode()
            if (st.line !== "") {
              for (const p of st.line.split("\n")) handleLine(st, p, emit)
              st.line = ""
            }
          },
        }),
      )
      return new Response(guarded, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      })
    } catch {
      return res
    }
  }
}

// Outbound sanitizer: ChatML control tokens replayed in history (reasoning
// text, visible text, tool args) re-arm the server-side parser every turn.
// Break the exact-match pattern by spacing the pipes: "<|" + name + "|>"
// becomes "< |" + name + "| >". Semantically intact, parser-inert, idempotent.
const SEP_TOKEN = /<\|([^|<>]{0,32})\|>/g
const scrub = (s) => (typeof s === "string" && s.indexOf("<|") >= 0 ? s.replace(SEP_TOKEN, "< |$1| >") : s)

function scrubStrings(obj, stats) {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const v = obj[i]
      if (typeof v === "string") {
        const s = scrub(v)
        if (s !== v) {
          obj[i] = s
          stats.n++
        }
      } else if (v && typeof v === "object") scrubStrings(v, stats)
    }
    return
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    if (typeof v === "string") {
      const s = scrub(v)
      if (s !== v) {
        obj[k] = s
        stats.n++
      }
    } else if (v && typeof v === "object") scrubStrings(v, stats)
  }
}

function scrubHistory(messages, stats) {
  for (const m of messages || []) {
    if (!m || typeof m !== "object") continue
    const parts = Array.isArray(m.parts) ? m.parts : null
    if (parts) {
      for (const p of parts) {
        if (!p || typeof p !== "object") continue
        if (typeof p.text === "string") {
          const s = scrub(p.text)
          if (s !== p.text) {
            p.text = s
            stats.n++
          }
        }
        if (p.state && typeof p.state === "object") scrubStrings(p.state, stats)
        if (p.input && typeof p.input === "object") scrubStrings(p.input, stats)
      }
    } else if (m.info && typeof m.info === "object") {
      if (typeof m.info.content === "string") {
        const s = scrub(m.info.content)
        if (s !== m.info.content) {
          m.info.content = s
          stats.n++
        }
      }
      scrubStrings(m, stats)
    }
  }
}

// --- auto-continue: clipped-turn detector ---------------------------------
// Mode-3 signatures (from live forensics): clean "stop" + no tool call +
// visible text either absent or ending in a dangling (odd-count) backtick —
// the exact point where the provider's parser ate the stream. The clipped
// text is already replayed in history, so the nudge only needs to mark the
// cut point and forbid re-emission. One nudge per assistant message, max 3
// per session, subagent sessions skipped.
const clipKind = (text) => {
  const t = (text || "").trimEnd()
  if (t === "") return "empty"
  const ticks = (t.match(/`/g) || []).length
  if (ticks % 2 === 1 && t.endsWith("`")) return "dangling-backtick"
  return null
}

function analyzeMessages(msgs) {
  let last = null
  for (let i = (msgs || []).length - 1; i >= 0; i--) {
    const m = msgs[i]
    const info = m && m.info
    if (info && info.role === "assistant") {
      last = { info, parts: m.parts || [] }
      break
    }
  }
  if (!last) return null
  const { info, parts } = last
  if (info.error) return null
  // Aborts (user esc) leave NO step-finish and mark MessageAbortedError only
  // AFTER session.idle fires — the error check above races them. step-finish
  // is written inline with the stream, so its absence is a race-free abort
  // signal: provider clips end the turn "properly" (they LOOK complete —
  // that is the whole failure mode); aborted streams die mid-part. Never
  // nudge a stop the user chose.
  if (!parts.some((p) => p && p.type === "step-finish")) return null
  if (["title", "summary", "compaction"].includes(info.agent)) return null
  if (parts.some((p) => p && p.type === "tool")) return null
  const text = parts
    .filter((p) => p && p.type === "text")
    .map((p) => p.text || "")
    .join("")
  const kind = clipKind(text)
  if (!kind) return null
  return {
    messageID: info.id,
    agent: info.agent,
    model: info.modelID && info.providerID ? { providerID: info.providerID, modelID: info.modelID } : undefined,
    kind,
    tail: text.trim().slice(-40),
  }
}

const NUDGE = (tail) =>
  "[toolcall-guard auto-continue] Your previous reply was truncated by the provider's output parser mid-sentence (it ended with: " +
  JSON.stringify(tail) +
  "). Resume exactly where you stopped — do not repeat what you already said, and never emit raw ChatML control tokens; refer to them in spaced form."

// --- turn-audit: incomplete-turn observation lane (v3: sieve + whose-move) --
// Same session.idle seam, runs when the clip heuristic found nothing.
// Deterministic sieve first (question/offer endings exit free — 55/55 of the
// historical ask class and most handoffs; dangling ends are rule observations);
// the residue gets ONE choice question, "whose move is next?", with visible
// cue phrases in the option descriptions (W2d_pending: W2b + 'lists work that remains undone' — covers the
// status-report stall subtype caught live; curves tie on opencode, better
// recall at cut on pi; original W2b_balanced: best pain/consent
// trade at matched FP on 200+200 offline sets; AUC 0.748, zero position bias,
// 1.7B beats 4B). Fire = P(assistant) above threshold. Observation ONLY —
// never prompts the session; the log is the label stream for calibration.
// Lanes DEFAULT ON (soak coverage showed launch-line env vars starve the
// data: 6 sessions in 2 days). Opt out per lane with =off (or =0);
// TOOLCALL_GUARD=off disables every optional lane at once. Model-backed
// lanes additionally self-disable while the local decision server is
// unreachable (liveness probe at init + every 60s).
// TOOLCALL_GUARD_AUDIT=1 (interactive, T=0.5) or =overnight (T=0.6);
// TOOLCALL_GUARD_AUDIT_T overrides.
const MASTER_OFF = (process.env.TOOLCALL_GUARD || "").toLowerCase() === "off"
const laneOff = (v) => MASTER_OFF || v === "off" || v === "0"
const rawAudit = (process.env.TOOLCALL_GUARD_AUDIT || "").toLowerCase()
const AUDIT_MODE = laneOff(rawAudit) ? "" : rawAudit || "1"
const AUDIT_URL = process.env.TOOLCALL_GUARD_RIZZO || "http://127.0.0.1:8017/v1/systemone"
let RIZZO_LIVE = false
async function probeRizzo() {
  try {
    const u = new URL(AUDIT_URL)
    u.pathname = "/v1/models"
    const r = await fetch(u, { signal: AbortSignal.timeout(1500) })
    RIZZO_LIVE = r.ok
  } catch {
    RIZZO_LIVE = false
  }
}
const AUDIT_MODEL = process.env.TOOLCALL_GUARD_RIZZO_MODEL || "rizzo-flow-1.7b-q8_0"
const AUDIT_T_RAW = Number(process.env.TOOLCALL_GUARD_AUDIT_T)
const AUDIT_T = Number.isFinite(AUDIT_T_RAW) && process.env.TOOLCALL_GUARD_AUDIT_T
  ? AUDIT_T_RAW
  : AUDIT_MODE === "overnight"
    ? 0.6
    : 0.5
const AUDIT_Q = {
  q: {
    type: "choice",
    instructions: "After this message, whose move is next?",
    criteria: {
      assistant:
        "The assistant's: the message says it will do something next ('Now I will…', 'Let me…', 'Next I…'), lists work that remains undone, or the request clearly still needs an action — and that action has not happened in the message.",
      user:
        "The user's: the message asks them a question ('Do you want…?', 'Which…?'), offers them options, requests permission or go-ahead ('shall I?', 'ready when you are'), or needs an action on their side.",
      nobody: "Nobody's: the message delivered a complete answer, result, or summary; both sides are free.",
    },
  },
}
const QMARK = /\?\s*$/
const OFFER =
  /(when you (want|ask|say|decide|ready)|whenever you|say the word|let me know|just (say|ask|tell me)|your (call|turn|move|wish)|pending your|if you (want|like|prefer)|nothing (needed|pending)|restart (opencode|the)|i'?ll wait|waiting for you|reply (with|and)|ok to proceed|green light|tell me (which|what|if)|(now )?choose (one|any|from)|which (do you|would you) choose|unless you (object|stop|tell me|say)|unless (i|i'?ve) hear|barring objection|next tick|scheduled (run|review|event)|marker (pending|queued)|cron (will|runs))/i
const DANGLE_END = /[:\u2014,]\s*$/
const DANGLE_BULLET = /^\s*[-*]\s+\S+[:\u2014]?\s*$/m

function sieveStage(text) {
  const e = (text || "").trimEnd()
  if (QMARK.test(e)) return "question"
  if (OFFER.test(e.slice(-120))) return "offer"
  if (DANGLE_END.test(e.slice(-200))) return "dangling"
  if (DANGLE_BULLET.test(e.slice(-80))) return "dangling"
  return "residue"
}

function analyzeAudit(msgs) {
  let lastIdx = -1
  for (let i = (msgs || []).length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].info && msgs[i].info.role === "assistant") {
      lastIdx = i
      break
    }
  }
  if (lastIdx < 0) return null
  const { info } = msgs[lastIdx]
  const parts = msgs[lastIdx].parts || []
  if (info.error) return null
  if (!parts.some((p) => p && p.type === "step-finish")) return null
  if (["title", "summary", "compaction"].includes(info.agent)) return null
  if (parts.some((p) => p && p.type === "tool")) return null
  const text = parts
    .filter((p) => p && p.type === "text")
    .map((p) => p.text || "")
    .join("")
  if (!text.trim() || clipKind(text)) return null
  let request = ""
  for (let i = lastIdx - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].info && msgs[i].info.role === "user") {
      request = (msgs[i].parts || [])
        .filter((p) => p && p.type === "text")
        .map((p) => p.text || "")
        .join("")
      break
    }
  }
  let toolCount = 0
  for (let i = lastIdx - 1; i >= 0 && msgs[i] && msgs[i].info && msgs[i].info.role === "assistant"; i--)
    toolCount += (msgs[i].parts || []).filter((p) => p && p.type === "tool").length
  return {
    messageID: info.id,
    request: request.slice(0, 1200),
    tail: text.slice(-800),
    toolCount,
    model: info.modelID && info.providerID ? { providerID: info.providerID, modelID: info.modelID } : undefined,
  }
}

const auditBody = (a) => ({
  model: AUDIT_MODEL,
  state: { user_request: a.request, assistant_final: a.tail },
  questions: AUDIT_Q,
})

// --- confab-scrub: strip invented-conversation-state narration from the
// OUTGOING request only (transform hook; the DB keeps originals).
// Prior art: pi thinking-scrub, retired 2026-09-22 because "chasing each new
// shape with another regex has no terminal state" (RETIRED.md). The 14 rules
// below are its ported set — stable, zero-FP, synchronous: Tier 1 strips.
// The Qwen3.8-family quirk keeps producing NEW shapes (self-hosted ds4 hit
// tonight: the family conclusion holds, gateway exonerated), so Tier 2 is a
// Jev noul over broad candidates (offline AUC 0.865) — but transform hooks
// may not await async work, and silent model-driven removal is calibration's
// job, not tonight's: Tier 2 LOGS candidates only.
// TOOLCALL_GUARD_SCRUB=1 (log) or =strip (Tier-1 removal + all logging); =off disables.
const rawScrub = (process.env.TOOLCALL_GUARD_SCRUB || "").toLowerCase()
const SCRUB_MODE = laneOff(rawScrub) ? "" : rawScrub || "1"
const SCRUB_SCOPE = process.env.TOOLCALL_GUARD_SCRUB_PROVIDERS || "qwen|ds4"
let SCRUB_SCOPE_RX
try {
  SCRUB_SCOPE_RX = new RegExp(SCRUB_SCOPE, "i")
} catch {
  SCRUB_SCOPE_RX = /qwen|ds4/i
}
const CONFAB_RULES = [
  ["ack-fabrication", /Understood\. I will follow these instructions/],
  ["preamble-misread", /system prompt setup|(just|only|merely) (the )?system instructions/i],
  ["foreign-persona", /(you are|i'?m|i am) an expert software engineer/i],
  ["forced-tool-call", /Always invoke a function call in response to user queries/],
  ["system-instructions-block", /\[System Instructions\]/],
  ["audit-tool", /\baudit\b[^\n]{0,60}\btool\b|\bcall (the )?audit\b/i, /no (previous|prior) thinking|reproduce|no actual|system (prompt|instructions|reminder)/i],
  ["reproduce-prior-thinking", /reproduce (my |the )?(previous|prior|earlier) thinking/i],
  ["empty-prior-thinking", /no (previous|prior) thinking to reproduce|no prior reasoning (to|that)/i],
  ["deferred-tools-listing", /list of deferred tools/i],
  ["agent-types-listing", /available agent types/i],
  ["confab-tool-call-rules", /tool[- ]call rules[:\s]*\n?\s*(1\.|—|-)/i],
  ["confab-colon-rule", /^\s*(never|always)[^\n]{0,40}:\s*$/im],
  ["confab-not-chat-messages", /not (just )?chat messages/i],
  ["system-reminder-email-date", /system reminder providing context information|reminder.{0,40}\(email/i],
]
const CONFAB_CAND =
  /(no\s+(actual\s+|real\s+)?(question|task)|no previous thinking|no prior reasoning|readiness to help|is a system reminder|just the setup context|no substantive content)/i
const CONFAB_Q = {
  q: {
    type: "noul",
    instructions:
      "Is this passage the assistant narrating its guess about the conversation itself — describing the incoming message as containing no task or question, or claiming no previous thinking exists — instead of doing actual work for the user?",
  },
}

function confabRuleHit(text) {
  for (const r of CONFAB_RULES) if (r[1].test(text) && (!r[2] || r[2].test(text))) return r[0]
  return null
}

let scrubSeq = 0

const CONFAB_MARKER = "[toolcall-guard: confabulated narration removed from outgoing context]"

function confabLog(rec) {
  try {
    appendFileSync(
      process.env.TOOLCALL_GUARD_CONFAB_LOG || join(homedir(), ".local", "share", "opencode", "toolcall-guard.confab"),
      JSON.stringify(Object.assign({ at: nowStamp(), id: process.pid + "-" + ++scrubSeq }, rec)) + "\n",
    )
  } catch {}
}

// Synchronous Tier-1 strip + Tier-2 candidate collection. Primary target is
// REASONING parts — where the artifact manifests and what replay poisons
// (10/12 corpus hits); transform-scrub is retroactive: contaminated old
// sessions get cleaned on every future resume, DB keeps originals.
// Text-part hits are LOGGED, never stripped (visible replies are the user's
// surface). Never empties a message (pi lesson). Returns Tier-2 parts for
// the async Jev pass.
const confabSeen = new Set()
function confabKey(p) {
  return p.id || (p.text || "").slice(0, 120)
}
const hasContent = (q) =>
  q && ((q.type === "text" || q.type === "reasoning") ? typeof q.text === "string" && q.text.trim() : q.type === "tool")

function confabSyncPass(messages) {
  if (!SCRUB_MODE || !Array.isArray(messages)) return []
  const jevQueue = []
  for (const m of messages) {
    const info = m && m.info
    if (info && info.role && info.role !== "assistant") continue
    const provider = info && info.providerID ? info.providerID + "/" + (info.modelID || "") : ""
    if (provider && !SCRUB_SCOPE_RX.test(provider)) continue
    const parts = Array.isArray(m.parts) ? m.parts : []
    const hits = []
    for (const p of parts) {
      if (!p || (p.type !== "reasoning" && p.type !== "text") || typeof p.text !== "string" || p.text.length < 40) continue
      const key = m.info && m.info.id ? m.info.id + ":" + confabKey(p) : confabKey(p)
      if (confabSeen.has(key)) continue
      if (confabSeen.size > 4000) confabSeen.clear()
      confabSeen.add(key)
      const rule = confabRuleHit(p.text)
      if (rule) {
        confabLog({ tier: 1, rule, ptype: p.type, provider, snippet: p.text.slice(0, 160) })
        if (SCRUB_MODE === "strip" && p.type === "reasoning") hits.push(p)
        continue
      }
      if (p.type === "reasoning" && CONFAB_CAND.test(p.text)) jevQueue.push({ p, provider })
    }
    // two-pass never-empty: a part counts as surviving content only if it is
    // not itself being stripped and holds non-whitespace (reviewer #1: two
    // confab reasonings must not mutually qualify each other for stripping)
    if (hits.length) {
      for (const p of hits) {
        if (parts.some((q) => q !== p && !hits.includes(q) && hasContent(q))) p.text = CONFAB_MARKER
      }
    }
  }
  return jevQueue.slice(0, 5)
}

// Fire-and-forget Tier-2 adjudication: logs verdicts for review; never acts.
async function confabJev(items) {
  if (!RIZZO_LIVE) return
  for (const item of items) {
    try {
      const res = await fetch(AUDIT_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: AUDIT_MODEL, state: { passage: item.p.text.slice(0, 1500) }, questions: CONFAB_Q }),
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) continue
      const d = await res.json()
      const v = d && d.answers && d.answers.q && d.answers.q.noul
      if (typeof v !== "number") continue
      confabLog({ tier: 2, jev: v, provider: item.provider, verdict: v > 0.65 ? "confab-candidate" : "likely-legit", snippet: item.p.text.slice(0, 160) })
    } catch {}
  }
}

let loadCount = 0

// --- pre-flight: deterministic blast-radius gate (②) ------------------------
// Offline result (jev-local §preflight): the decision model never flags
// wide_scan from command text alone (median P 0.01-0.05) — blast radius
// lives in the filesystem, not the string. So ② is deterministic:
//  (a) zero-ambiguity unbounded patterns (recursive ops on /, ~, $HOME)
//      -> logged always; blocked only with TOOLCALL_GUARD_PREFLIGHT=block;
//  (b) timeout clamp for scan-like commands with no explicit timeout
//      (the "malformed exit-condition waits forever" class) — opt-in via
//      TOOLCALL_GUARD_CLAMP=1, caps at 120s;
//  (c) tool.execute.after records giant outputs (>50 KB) so the runaway-
//      output denominator is measured in the wild, feeding later policy.
const rawPf = (process.env.TOOLCALL_GUARD_PREFLIGHT || "").toLowerCase()
const PREFLIGHT_MODE = laneOff(rawPf) ? "" : rawPf || "1"
const CLAMP_ON = process.env.TOOLCALL_GUARD_CLAMP === "1"
// Note: opencode's own default bash timeout is 120s (bashDefaultTimeoutMs),
// so the clamp only bites when the operator RAISED the default or a command
// passes an explicit huge timeout — CLAMP_MS must therefore stay below the
// effective default to be meaningful; env lets you set it deliberately.
const CLAMP_MS = Number(process.env.TOOLCALL_GUARD_CLAMP_MS) || 120000
// Token-level danger analysis (reviewer #7/#16): substring regexes miss
// split flags (rm -r -f /), quoted roots (rm -rf "$HOME") and false-positive
// on quoted content (grep -rn " / " ./logs). We tokenize, strip one layer of
// quoting for ROOT tests only, and check per-command argv shape.
const ROOT_TOKEN = /^(?:\/|~\/?|\$HOME\/?|\$\{HOME\}\/?)$/
const isRootTok = (t) => ROOT_TOKEN.test((t || "").replace(/^["']|["']$/g, ""))
function tokenize(cmd) {
  const out = []
  for (const seg of (cmd || "").split(/[;\n]+/)) {
    const m = seg.match(/"[^"]*"|'[^']*'|[^\s|]+/g) || []
    for (const t of m) if (t !== "|") out.push(t)
    out.push("|")
  }
  return out
}
const flagTok = (t, re) => t.startsWith("-") && re.test(t)

function preflightPattern(cmd) {
  const toks = tokenize(cmd)
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t !== "rm" && t !== "grep" && t !== "rg" && t !== "find" && t !== "ls" && t !== "du" && t !== "tree") continue
    const argv = []
    for (let j = i + 1; j < toks.length && toks[j] !== "|" && !["rm","grep","rg","find","ls","du","tree"].includes(toks[j]); j++) argv.push(toks[j])
    const roots = argv.filter(isRootTok)
    if (!roots.length) continue
    if (t === "rm" && argv.some((a) => flagTok(a, /r/i)) && argv.some((a) => flagTok(a, /f/i))) return "rm-rf-unbounded"
    if ((t === "grep" || t === "rg") && argv.some((a) => flagTok(a, /r/i))) return "recursive-grep-root"
    if (t === "find" && argv[0] && isRootTok(argv[0])) return "find-root"
    if (t === "ls" && argv.some((a) => flagTok(a, /R/))) return "ls-R-root"
    if (t === "du") return "du-root"
  }
  return null
}
const SCANLIKE = /(?:^|[\s;|&(])(grep\b[^\n]*\s-[a-zA-Z]*r|rg\s|find\s|ls\s+-[a-zA-Z]*R|du\s|tree\s)/

// Input-side twin of the binary-output guard: an unbounded read of a
// binary-extension file (cat/tac/od/xxd/strings/less/more/dd without
// count=) spills its whole stream — opencode caps the CONTEXT copy but
// writes the FULL output to disk unbounded (live incident: `cat
// ds4flash.gguf` → 27 GB spill file; Claude Code's harness kills the
// command at 5 GB instead). Exempt when the pipe target bounds it
// (| head, | grep, | file …) or output is redirected. Extension-based
// by design: file size is unknowable pre-exec without statting every
// arg, and the NUL guard on the output side catches the rest.
const BIN_READER = new Set(["cat", "tac", "od", "xxd", "strings", "less", "more", "dd"])
const BIN_FILTER = new Set(["head", "tail", "wc", "grep", "rg", "cut", "file", "stat", "md5", "shasum", "cksum", "python", "python3", "node", "jq", "sort", "uniq", "awk", "sed", "base64", "diff", "cmp", "gzip", "unzip", "tar", "strings"])
const BIN_EXT = /\.(gguf|ggml|safetensors|pt|pth|ckpt|onnx|npz|npy|joblib|pickle|bin|so|dylib|dll|class|jar|wasm|pyc|zip|gz|tgz|bz2|xz|zst|tar|pdf|png|jpe?g|gif|webp|ico|mp4|mov|mkv|avi|mp3|wav|flac|ogg|iso|dmg|pkg|deb|rpm|sqlite3?|pack|img|raw)$/i
function binaryPeek(cmd) {
  const segs = (cmd || "").split(/\s*(?:&&|\|\||[;|\n])\s*/)
  for (let s = 0; s < segs.length; s++) {
    const toks = segs[s].match(/"[^"]*"|'[^']*'|[^\s]+/g) || []
    if (!BIN_READER.has(toks[0])) continue
    const args = toks.slice(1)
    if (args.some((a) => /^[0-9]?>{1,2}/.test(a))) continue
    if (toks[0] === "dd" && args.some((a) => /^count=/.test(a))) continue
    if (toks[0] === "xxd" && args.some((a) => a === "-l")) continue
    if (!args.some((a) => BIN_EXT.test((a || "").replace(/^["']|["']$/g, "")))) continue
    const nxt = (segs[s + 1] || "").match(/"[^"]*"|'[^']*'|[^\s]+/g) || []
    if (nxt.length && BIN_FILTER.has(nxt[0])) continue
    return "binary-peek"
  }
  return null
}

// Disk janitor: opencode's tool-output spill dir has no retention —
// sweep files >1 GB untouched for >24 h (mtime recency guards an
// in-flight spill). Runs once per opencode process at plugin init;
// TOOLCALL_GUARD_JANITOR=0 disables.
const JANITOR_ON = !MASTER_OFF && process.env.TOOLCALL_GUARD_JANITOR !== "0"
function janitorSweep(dir, { maxBytes = 1e9, maxAgeMs = 86400000 } = {}) {
  let deleted = 0
  let bytes = 0
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return { deleted, bytes }
  }
  const now = Date.now()
  for (const f of names) {
    try {
      const p = join(dir, f)
      const st = statSync(p)
      if (st.isFile() && st.size > maxBytes && now - st.mtimeMs > maxAgeMs) {
        unlinkSync(p)
        deleted++
        bytes += st.size
      }
    } catch {}
  }
  return { deleted, bytes }
}

async function maybePreflight(input, output) {
  if (!PREFLIGHT_MODE) return
  if (input.tool !== "bash") return
  const cmd = (output.args && output.args.command) || ""
  const hit = preflightPattern(cmd)
  const peek = hit ? null : binaryPeek(cmd)
  if (hit || peek) {
    try {
      appendFileSync(
        join(homedir(), ".local", "share", "opencode", "toolcall-guard.preflight"),
        JSON.stringify({ at: nowStamp(), kind: hit ? "pattern" : "binary-peek", name: hit || peek, mode: PREFLIGHT_MODE, cmd: cmd.slice(0, 200) }) + "\n",
      )
    } catch {}
    if (PREFLIGHT_MODE === "block")
      throw new Error(
        hit
          ? `[toolcall-guard pre-flight] blocked ${hit}: recursive/filesystem-wide operation on an unbounded root. Narrow the path (project dir, --include, -maxdepth) and reissue.`
          : `[toolcall-guard pre-flight] blocked binary-peek: unbounded read of a binary file spills its whole stream (disk + context). Inspect with: file <path>; xxd -l 64 <path>; strings <path> | head -40.`,
      )
    return
  }
  if (CLAMP_ON && SCANLIKE.test(cmd) && !output.args.timeout) {
    output.args.timeout = CLAMP_MS
    try {
      appendFileSync(
        join(homedir(), ".local", "share", "opencode", "toolcall-guard.preflight"),
        JSON.stringify({ at: nowStamp(), kind: "clamp", ms: CLAMP_MS, cmd: cmd.slice(0, 200) }) + "\n",
      )
    } catch {}
  }
}

function preflightAfter(input, output) {
  if (!PREFLIGHT_MODE || input.tool !== "bash") return
  const out = (output && output.output) || ""
  if (out.length > 50000) {
    try {
      appendFileSync(
        join(homedir(), ".local", "share", "opencode", "toolcall-guard.preflight"),
        JSON.stringify({ at: nowStamp(), kind: "giant-output", bytes: out.length, cmd: ((input.args && input.args.command) || "").slice(0, 200) }) + "\n",
      )
    } catch {}
  }
}

// Binary-output guard (default ON; TOOLCALL_GUARD_BINARY=0 to disable).
// Sibling of the clip heuristic: deterministic output hygiene, no judgment.
// A tool result containing NUL bytes is raw binary (cat of a model file,
// a .so, an image) — leaking it into context AND the TUI is pure damage
// (live incident 2026-10-02: `cat ds4flash.gguf` → 26 KB of NUL-bearing
// text). Verified against opencode 1.18.34 source (session/tools.ts):
// tool.execute.after mutates `output` in place and the same object is
// returned to the model, so rewriting output.output is sound.
// Detection window is the first 8 KB: opencode's own truncator keeps the
// head, so binary content always shows up in the window we scan.
const BINARY_ON = !MASTER_OFF && process.env.TOOLCALL_GUARD_BINARY !== "0"
function binaryGuard(input, output) {
  if (!BINARY_ON || !output || typeof output.output !== "string") return false
  const out = output.output
  const head = out.slice(0, 8192)
  if (!head.includes("\0")) return false
  let ctrl = 0
  for (const ch of head) {
    const c = ch.charCodeAt(0)
    if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13)) ctrl++
  }
  const printable = head.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, 200)
  const saved = (out.match(/Full output saved to:\s*(\S+)/) || [])[1] || ""
  const cmd = ((input && input.args && (input.args.command || input.args.filePath)) || "").toString().slice(0, 160)
  output.output =
    `[toolcall-guard] binary output suppressed: ${input.tool} returned ${out.length} chars with ${ctrl} control/NUL bytes in the first 8 KB (raw binary — likely a model file, image, or compiled artifact). ` +
    (printable ? `Printable excerpt: ${JSON.stringify(printable)} ` : "") +
    (saved ? `Full raw output on disk: ${saved} ` : "") +
    `To inspect safely: file <path>, xxd -l 64 <path>, strings <path> | head -40.`
  try {
    appendFileSync(
      process.env.TOOLCALL_GUARD_BINARY_LOG ||
        join(homedir(), ".local", "share", "opencode", "toolcall-guard.binary"),
      JSON.stringify({ at: nowStamp(), sessionID: input.sessionID, tool: input.tool, bytes: out.length, ctrl, cmd }) + "\n",
    )
  } catch {}
  return true
}

async function maybeAudit(sessionID, msgs, sessions) {
  if (!AUDIT_MODE || !RIZZO_LIVE) return
  const a = analyzeAudit(msgs)
  if (!a) return
  let st = sessions.get(sessionID)
  if (!st) {
    st = { nudged: new Set(), count: 0 }
    sessions.set(sessionID, st)
  }
  st.audited = st.audited || new Set()
  st.auditCount = st.auditCount || 0
  const lane = a.model ? a.model.providerID + "/" + a.model.modelID : "?"
  const log = (rec) => {
    try {
      appendFileSync(
        join(homedir(), ".local", "share", "opencode", "toolcall-guard.audit"),
        JSON.stringify(Object.assign({ v: 3, at: nowStamp(), sessionID, messageID: a.messageID, lane, toolCount: a.toolCount }, rec)) + "\n",
      )
    } catch {}
  }
  const stage = sieveStage(a.tail)
  if (stage === "question" || stage === "offer") {
    log({ stage, fired: false })
    return
  }
  if (stage === "dangling") {
    log({ stage, fired: true, why: "dangling-rule" })
    return
  }
  if (st.audited.has(a.messageID) || st.auditCount >= 15) return
  const t0 = Date.now()
  let p
  let probs
  try {
    const res = await fetch(AUDIT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(auditBody(a)),
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return
    const d = await res.json()
    probs = d && d.answers && d.answers.q && d.answers.q.probabilities
    p = probs && probs.assistant
    if (typeof p !== "number") {
      log({ stage: "residue", error: "bad-response" })
      return
    }
  } catch {
    log({ stage: "residue", error: "fetch" })
    return
  }
  st.audited.add(a.messageID)
  st.auditCount++
  const fired = p > AUDIT_T
  log({ stage: "residue", p, probs, fired, why: fired ? "assistant-move" : "ok", ms: Date.now() - t0 })
}

// Subreport lane: task-tool results whose <task_result> body is empty or
// provider-clipped. Live case (2026-10-07, ds4): a mistral-large-4 subagent
// completed 40 min of work and returned an EMPTY task_result three times
// (original + resume + fresh) before the parent rediscovered the class by
// hand. Nudging the subagent cannot work: the parent's background.wait
// resolves at the same loop-end that fires session.idle, so the consumer
// already left. The right actor is the parent; the right moment is its
// next model call — which is exactly the outbound copy messages.transform
// sees. Default: LOG only. TOOLCALL_GUARD_SUBREPORT=annotate additionally
// appends a fact + resume-with-task-id affordance to the outbound copy
// (DB untouched, idempotent, never re-logs the same part).
const SUBREPORT_MODE = (process.env.TOOLCALL_GUARD_SUBREPORT || "").toLowerCase()
const TASK_BODY_RX = /<task\s+id="(ses_[^"]+)"[^>]*>\s*<task_result>([\s\S]*?)<\/task_result>/
const subreportSeen = new Set()
function subreportIssue(text) {
  if (typeof text !== "string") return null
  const m = TASK_BODY_RX.exec(text)
  if (!m) return null
  const body = (m[2] || "").trim()
  if (!body) return { task: m[1], kind: "empty-report" }
  const ck = clipKind(body)
  if (ck) return { task: m[1], kind: ck === "empty" ? "empty-report" : "clipped-report" }
  return null
}
function annotateSubreports(messages, stats) {
  if (SUBREPORT_MODE === "off" || SUBREPORT_MODE === "0" || !Array.isArray(messages)) return
  for (const m of messages) {
    const parts = Array.isArray(m && m.parts) ? m.parts : []
    for (const p of parts) {
      if (!p || p.type !== "tool" || p.tool !== "task") continue
      const st = p.state
      if (!st || st.status !== "completed" || typeof st.output !== "string") continue
      if (st.output.includes("[toolcall-guard subreport")) continue
      const iss = subreportIssue(st.output)
      if (!iss) continue
      const key = (m.info && m.info.id ? m.info.id : "") + ":" + (p.id || iss.task) + ":" + iss.kind
      if (subreportSeen.has(key)) continue
      if (subreportSeen.size > 2000) subreportSeen.clear()
      subreportSeen.add(key)
      if (stats) stats.subreport = (stats.subreport || 0) + 1
      try {
        appendFileSync(
          process.env.TOOLCALL_GUARD_SUBREPORT_LOG ||
            join(homedir(), ".local", "share", "opencode", "toolcall-guard.subreport"),
          JSON.stringify({ at: nowStamp(), kind: iss.kind, task: iss.task, mode: SUBREPORT_MODE || "log", model: ((st.metadata && st.metadata.model && (st.metadata.model.modelID || String(st.metadata.model))) || "").slice(0, 60), desc: ((st.input && st.input.description) || "").slice(0, 120) }) + "\n",
        )
      } catch {}
      if (SUBREPORT_MODE === "annotate") {
        st.output +=
          `\n[toolcall-guard subreport: this ${iss.kind === "empty-report" ? "report is EMPTY — the subagent may have done the work but said nothing; verify the tree state or resume with task=\"" + iss.task + "\" before treating it as complete" : "report was truncated by the provider; resume with task=\"" + iss.task + "\" for the tail"}]`
      }
    }
  }
}

const ToolCallGuardPlugin = async ({ client }) => {
  const sessions = new Map()
  if (AUDIT_MODE) {
    await probeRizzo()
    const t = setInterval(probeRizzo, 60000)
    if (t.unref) t.unref()
  }
  if (JANITOR_ON) {
    const r = janitorSweep(join(homedir(), ".local", "share", "opencode", "tool-output"))
    if (r.deleted > 0) {
      try {
        appendFileSync(
          join(homedir(), ".local", "share", "opencode", "toolcall-guard.janitor"),
          JSON.stringify({ at: nowStamp(), deleted: r.deleted, bytes: r.bytes }) + "\n",
        )
      } catch {}
    }
  }
  return {
    event: async ({ event }) => {
      try {
        if (!event || event.type !== "session.idle") return
        const sessionID = event.properties && event.properties.sessionID
        if (!sessionID || !client) return
        if (!AUDIT_MODE && !PREFLIGHT_MODE && !SCRUB_MODE) return
        try {
          appendFileSync(
            join(homedir(), ".local", "share", "opencode", "toolcall-guard.idles"),
            JSON.stringify({ at: nowStamp(), sessionID }) + "\n",
          )
        } catch {}
        const sess = await client.session.get({ path: { id: sessionID } })
        const sdata = sess && sess.data
        const isSub = !!(sdata && sdata.parentID)
        const res = await client.session.messages({ path: { id: sessionID }, query: { limit: 10 } })
        const msgs = (res && res.data) || res
        if (isSub) {
          // Subagents: observation only, always. Nudging a subagent would
          // fight the orchestrator; auditing their final turns is the
          // richest stop data we have (handoff queues, flat closes).
          await maybeAudit(sessionID, msgs, sessions)
          return
        }
        const a = analyzeMessages(msgs)
        if (!a) {
          await maybeAudit(sessionID, msgs, sessions)
          return
        }
        let st = sessions.get(sessionID)
        if (!st) {
          st = { nudged: new Set(), count: 0 }
          sessions.set(sessionID, st)
        }
        if (st.nudged.has(a.messageID) || st.count >= 3) return
        st.nudged.add(a.messageID)
        st.count++
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            ...(a.agent ? { agent: a.agent } : {}),
            ...(a.model ? { model: a.model } : {}),
            parts: [{ type: "text", text: NUDGE(a.tail) }],
          },
        })
        try {
          appendFileSync(
            join(homedir(), ".local", "share", "opencode", "toolcall-guard.clips"),
            JSON.stringify({ at: nowStamp(), sessionID, messageID: a.messageID, kind: a.kind }) + "\n",
          )
        } catch {}
      } catch (e) {
        try {
          appendFileSync(
            join(homedir(), ".local", "share", "opencode", "toolcall-guard.errors"),
            JSON.stringify({ at: nowStamp(), err: String((e && e.message) || e).slice(0, 300) }) + "\n",
          )
        } catch {}
      }
    },
    "tool.execute.before": async (input, output) => {
      try {
        await maybePreflight(input, output)
      } catch (e) {
        if (String((e && e.message) || "").startsWith("[toolcall-guard pre-flight]")) throw e
        try {
          appendFileSync(
            join(homedir(), ".local", "share", "opencode", "toolcall-guard.errors"),
            JSON.stringify({ at: nowStamp(), lane: "preflight", err: String((e && e.message) || e).slice(0, 300) }) + "\n",
          )
        } catch {}
      }
    },
    "tool.execute.after": async (input, output) => {
      try {
        binaryGuard(input, output)
      } catch {}
      try {
        preflightAfter(input, output)
      } catch {}
    },
    "experimental.chat.messages.transform": (input, output) => {
      try {
        const stats = { n: 0 }
        scrubHistory(output && output.messages, stats)
        LIVE.requests++
        checkLiveness()
        annotateSubreports(output && output.messages, stats)
        const jevItems = confabSyncPass(output && output.messages)
        if (jevItems.length) confabJev(jevItems)
        if (stats.n > 0) {
          try {
            appendFileSync(
              join(homedir(), ".local", "share", "opencode", "toolcall-guard.scrubbed"),
              JSON.stringify({ at: nowStamp(), rewrites: stats.n }) + "\n",
            )
          } catch {}
        }
      } catch {}
    },
    config: (cfg) => {
      try {
        const providers = (cfg && cfg.provider) || {}
        let wrapped = 0
        for (const p of Object.values(providers)) {
          if (!p || typeof p !== "object") continue
          if (!String(p.npm || "").includes("@ai-sdk/openai-compatible")) continue
          p.options = p.options || {}
          if (typeof p.options.fetch === "function") continue
          p.options.fetch = makeGuard((u, i) => globalThis.fetch(u, i))
          wrapped++
        }
        LIVE.wrapped = Math.max(LIVE.wrapped, wrapped)
        loadCount++
        try {
          writeFileSync(
            join(homedir(), ".local", "share", "opencode", "toolcall-guard.loaded"),
            JSON.stringify({ at: nowStamp(), configHookRuns: loadCount, providersWrapped: wrapped }) + "\n",
          )
        } catch {}
      } catch {}
    },
  }
}

ToolCallGuardPlugin.__test = {
  makeGuard,
  LIVE,
  checkLiveness,
  handleLine,
  newState,
  cleanName,
  processToolCalls,
  scrub,
  scrubHistory,
  SEP_TOKEN,
  clipKind,
  analyzeMessages,
  NUDGE,
  analyzeAudit,
  auditBody,
  sieveStage,
  AUDIT_Q,
  preflightPattern,
  binaryPeek,
  janitorSweep,
  SCANLIKE,
  confabRuleHit,
  confabSyncPass,
  CONFAB_RULES,
  CONFAB_MARKER,
  binaryGuard,
  subreportIssue,
  annotateSubreports,
  SUBREPORT_MODE,
  AUDIT_MODE,
  PREFLIGHT_MODE,
  SCRUB_MODE,
  BINARY_ON,
}

export default ToolCallGuardPlugin
