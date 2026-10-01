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

import { appendFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const cleanName = (v) => (typeof v === "string" ? v.replace(/^[\s`]+|[\s`]+$/g, "") : "")

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

function makeGuard(baseFetch) {
  return async function guardedFetch(input, init) {
    const res = await baseFetch(input, init)
    try {
      const url = typeof input === "string" ? input : (input && input.url) || ""
      const ct = (res.headers && res.headers.get("content-type")) || ""
      if (!res.ok || !res.body || !url.includes("/chat/completions") || !ct.includes("text/event-stream")) {
        return res
      }
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
// cue phrases in the option descriptions (W2b_balanced: best pain/consent
// trade at matched FP on 200+200 offline sets; AUC 0.748, zero position bias,
// 1.7B beats 4B). Fire = P(assistant) above threshold. Observation ONLY —
// never prompts the session; the log is the label stream for calibration.
// TOOLCALL_GUARD_AUDIT=1 (interactive, T=0.5) or =overnight (T=0.6);
// TOOLCALL_GUARD_AUDIT_T overrides.
const AUDIT_MODE = process.env.TOOLCALL_GUARD_AUDIT || ""
const AUDIT_URL = process.env.TOOLCALL_GUARD_RIZZO || "http://127.0.0.1:8017/v1/systemone"
const AUDIT_MODEL = process.env.TOOLCALL_GUARD_RIZZO_MODEL || "rizzo-flow-1.7b-q8_0"
const AUDIT_T = process.env.TOOLCALL_GUARD_AUDIT_T
  ? Number(process.env.TOOLCALL_GUARD_AUDIT_T)
  : AUDIT_MODE === "overnight"
    ? 0.6
    : 0.5
const AUDIT_Q = {
  q: {
    type: "choice",
    instructions: "After this message, whose move is next?",
    criteria: {
      assistant:
        "The assistant's: the message says it will do something next ('Now I will…', 'Let me…', 'Next I…') or the request clearly still needs an action, and that action has not happened in the message.",
      user:
        "The user's: the message asks them a question ('Do you want…?', 'Which…?'), offers them options, requests permission or go-ahead ('shall I?', 'ready when you are'), or needs an action on their side.",
      nobody: "Nobody's: the message delivered a complete answer, result, or summary; both sides are free.",
    },
  },
}
const QMARK = /\?\s*$/
const OFFER =
  /(when you (want|ask|say|decide|ready)|whenever you|say the word|let me know|just (say|ask|tell me)|your (call|turn|move|wish)|pending your|if you (want|like|prefer)|nothing (needed|pending)|restart (opencode|the)|i'?ll wait|waiting for you|reply (with|and)|ok to proceed|green light|tell me (which|what|if)|choose|pick one)/i
const DANGLE = /[:\u2014,]\s*$|^\s*[-*]\s+\S+[:\u2014]?\s*$/m

function sieveStage(text) {
  const e = (text || "").trimEnd()
  if (QMARK.test(e)) return "question"
  if (OFFER.test(e.slice(-350))) return "offer"
  if (DANGLE.test(e.slice(-200))) return "dangling"
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
  const { info, parts = [] } = msgs[lastIdx]
  if (info.error) return null
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

let loadCount = 0

async function maybeAudit(sessionID, msgs, sessions) {
  if (!AUDIT_MODE) return
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
        JSON.stringify(Object.assign({ v: 2, at: new Date().toISOString(), sessionID, messageID: a.messageID, lane, toolCount: a.toolCount }, rec)) + "\n",
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
  st.audited.add(a.messageID)
  st.auditCount++
  const t0 = Date.now()
  let p
  try {
    const res = await fetch(AUDIT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(auditBody(a)),
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return
    const d = await res.json()
    const probs = d && d.answers && d.answers.q && d.answers.q.probabilities
    p = probs && probs.assistant
    if (typeof p !== "number") return
  } catch {
    return
  }
  const fired = p > AUDIT_T
  log({ stage: "residue", p, probs, fired, why: fired ? "assistant-move" : "ok", ms: Date.now() - t0 })
}

const ToolCallGuardPlugin = async ({ client }) => {
  const sessions = new Map()
  return {
    event: async ({ event }) => {
      try {
        if (!event || event.type !== "session.idle") return
        const sessionID = event.properties && event.properties.sessionID
        if (!sessionID || !client) return
        const sess = await client.session.get({ path: { id: sessionID } })
        const sdata = sess && sess.data
        if (sdata && sdata.parentID) return
        const res = await client.session.messages({ path: { id: sessionID }, query: { limit: 10 } })
        const msgs = (res && res.data) || res
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
            JSON.stringify({ at: new Date().toISOString(), sessionID, messageID: a.messageID, kind: a.kind }) + "\n",
          )
        } catch {}
      } catch {}
    },
    "experimental.chat.messages.transform": (input, output) => {
      try {
        const stats = { n: 0 }
        scrubHistory(output && output.messages, stats)
        if (stats.n > 0) {
          try {
            appendFileSync(
              join(homedir(), ".local", "share", "opencode", "toolcall-guard.scrubbed"),
              JSON.stringify({ at: new Date().toISOString(), rewrites: stats.n }) + "\n",
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
        loadCount++
        try {
          writeFileSync(
            join(homedir(), ".local", "share", "opencode", "toolcall-guard.loaded"),
            JSON.stringify({ at: new Date().toISOString(), configHookRuns: loadCount, providersWrapped: wrapped }) + "\n",
          )
        } catch {}
      } catch {}
    },
  }
}

ToolCallGuardPlugin.__test = {
  makeGuard,
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
}

export default ToolCallGuardPlugin
