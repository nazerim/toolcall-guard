import { appendFileSync } from "node:fs"
import { join } from "node:path"

// Background acknowledgements are not reports. V2 delivers the outcome later
// as a synthetic parent message; lowering to role:user drops its metadata.
const childID = /^ses_[A-Za-z0-9_-]+$/
const suffix = "\n</subagent>"
// Cheap negative filter: avoid rereading stored context for healthy reports
// on every turn. The authenticated envelope is checked again below.
const suspect = /(?:">\n\s*|Subagent completed without a text response\.\s*|`\s*)\n<\/subagent>$/

export async function setupSubreport(ctx, { clipKind, DATA_DIR }) {
  // "1" means "log" (observe only), consistent with SCRUB=1 and AUDIT=1
  // never rewriting by default; annotating outbound context needs "annotate".
  const raw = process.env.TOOLCALL_GUARD_SUBREPORT?.toLowerCase()
  const mode = raw === "1" ? "log" : raw
  if (process.env.TOOLCALL_GUARD?.toLowerCase() === "off" || !["log", "annotate"].includes(mode)) return
  const seen = new Set()
  const registration = await ctx.session.hook("context", async (event) => {
    try {
      let stored
      for (const m of event.messages) {
        for (const p of m.content) {
          let id, prefix, text, key
          if (m.role === "tool" && p.type === "tool-result" && p.name === "subagent" && p.result?.type === "text") {
            text = p.result.value
            id = typeof text === "string" && /^<subagent sessionID="(ses_[A-Za-z0-9_-]+)" state="completed">\n/.exec(text)?.[1]
            if (!id) continue
            prefix = `<subagent sessionID="${id}" state="completed">\n`
            key = p.id
          } else if (m.role === "user" && p.type === "text" && p.text.startsWith("<subagent sessionID=") &&
                     suspect.test(p.text) && m.id) {
            // Do not trust lookalike user input. Query only for candidate
            // envelopes, at most once per request, including after reload.
            if (!stored) {
              const raw = await ctx.session.context({ sessionID: event.sessionID })
              stored = new Map((Array.isArray(raw) ? raw : raw.data)
                .filter((s) => s.type === "synthetic" && s.metadata?.source === "subagent" && s.metadata.state === "completed")
                .map((s) => [s.id, s]))
            }
            const s = stored.get(m.id)
            id = s?.metadata.childID
            if (!s || typeof id !== "string" || !childID.test(id) || s.text !== p.text) continue
            prefix = `<subagent sessionID="${id}" state="completed" description="${s.description}">\n`
            text = p.text
            key = m.id
          } else continue
          if (!text.startsWith(prefix) || !text.endsWith(suffix)) continue
          const body = text.slice(prefix.length, -suffix.length).trim()
          const kind = !body || body === "Subagent completed without a text response."
            ? "empty-report" : clipKind(body) ? "clipped-report" : null
          if (!kind) continue
          const unique = JSON.stringify([event.sessionID, key, id])
          if (!seen.has(unique)) {
            seen.add(unique)
            if (seen.size > 2000) seen.delete(seen.values().next().value)
            try {
              appendFileSync(join(DATA_DIR(), "toolcall-guard.subreport"),
                JSON.stringify({ at: new Date().toISOString(), mode, kind }) + "\n", { mode: 0o600 })
            } catch { /* Marker failure must not prevent annotation. */ }
          }
          if (mode !== "annotate") continue
          const note = `\n[toolcall-guard subreport: ${kind === "empty-report" ? "no text report" : "possibly clipped report"}; verify the work or resume with subagent sessionID="${id}".]`
          if (m.role === "tool") p.result = { ...p.result, value: text + note }
          else p.text = text + note
        }
      }
    } catch {
      // Diagnostics are optional: never break provider dispatch.
    }
  })
  return registration && (() => registration.dispose())
}
