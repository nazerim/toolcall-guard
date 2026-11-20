import { appendFileSync } from "node:fs"
import { join } from "node:path"

// Coverage marker for the core SSE guard (plugins/toolcall-guard.js).
//
// Why this lane exists: the core only recorded `non-sse` (once per process, on
// the 25th non-SSE response) and `repaired` (only with
// TOOLCALL_GUARD_V2_DEBUG=stream). A working guard therefore left a marker
// file that reads like "zero interceptions", which is how the V2 stream guard
// came to be reported as dead in main AND subagent sessions (2026-11-20) when
// a temporary live observer showed it wrapping child-session streams all along.
//
// This lane observes the same hook (registered BEFORE the core so it sees the
// original response) and writes at most MAX_LINES marker lines total, shared
// across every setup/Location in this module instance (hot re-loads that
// re-import the module re-arm the budget). Read-only: it never touches
// event.response.
//
// Observational, not attributional:
//   sse-seen          — this reporter saw a primary SSE response in the hook;
//                       the core is registered for the same events, but this
//                       line alone does not prove the core ran.
//   response-replaced — a hook registered after this one replaced
//                       event.response by the next macrotask (the core's
//                       wrapper is the only replacer configured; not proven).
//   non-sse-primary   — a primary response was NOT SSE: worth investigating,
//                       but not the only possible miss (active WebSocket
//                       frames never reach http.response).
// Like every lane, TOOLCALL_GUARD=off disables it; the core guard is what
// stays on regardless.
const MAX_LINES = 12
let linesWritten = 0

export async function setupStreamReport(ctx, { DATA_DIR }) {
  if (process.env.TOOLCALL_GUARD?.toLowerCase() === "off") return
  const write = (row) => {
    if (linesWritten >= MAX_LINES) return
    linesWritten++ // a failed append still burns budget: the bound limits ATTEMPTS
    try {
      appendFileSync(
        join(DATA_DIR(), "toolcall-guard.stream-info"),
        JSON.stringify({ at: new Date().toISOString(), lane: "v2-stream-report", n: linesWritten, ...row }) + "\n",
        { mode: 0o600 },
      )
    } catch { /* A marker failure must never affect provider dispatch. */ }
  }
  const registration = await ctx.session.hook("http.response", (event) => {
    try {
      if (linesWritten >= MAX_LINES) return
      const res = event.response
      if (!res || typeof res.ok !== "boolean" || !res.headers) return
      if (typeof res.headers.get !== "function") return
      if (!res.ok) return
      const ct = res.headers.get("content-type") || ""
      const sse = ct.split(";")[0].trim().toLowerCase() === "text/event-stream"
      // Only the agent loop streams chat completions; auxiliary requests
      // (title, compaction, generate, decision) legitimately answer JSON.
      const kind = event.kind || "primary"
      if (kind !== "primary") return
      if (!sse) {
        write({ reason: "non-sse-primary", kind, status: res.status, ct: ct.slice(0, 64) })
        return
      }
      write({ reason: "sse-seen", kind, sessionID: event.sessionID, status: res.status })
      // The core hook runs after this one in the same trigger pass; a macrotask
      // sees the settled event. A replacer that resolves later than the
      // macrotask is missed — under-reporting, never mis-reporting.
      setTimeout(() => {
        try {
          if (event.response && event.response !== res)
            write({ reason: "response-replaced", sessionID: event.sessionID })
        } catch {}
      }, 0)
    } catch { /* Diagnostics are optional: never break provider dispatch. */ }
  })
  return registration && (() => registration.dispose())
}
