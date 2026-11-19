import { appendFileSync } from "node:fs"
import { join } from "node:path"

export async function setupPreflight(ctx, { DATA_DIR, binaryPeek, preflightPattern, SCANLIKE }) {
  if (process.env.TOOLCALL_GUARD?.toLowerCase() === "off") return
  const mode = process.env.TOOLCALL_GUARD_PREFLIGHT
  const detect = mode === "1" || mode === "log" || mode === "block"
  const clamp = process.env.TOOLCALL_GUARD_CLAMP === "1"
  if (!detect && !clamp) return
  const ms = Number(process.env.TOOLCALL_GUARD_CLAMP_MS ?? 120000)
  function record(fields) {
    try {
      appendFileSync(join(DATA_DIR(), "toolcall-guard.preflight"),
        JSON.stringify({ at: new Date().toISOString(), ...fields }) + "\n", { mode: 0o600 })
    } catch { /* A marker failure must never affect tool execution. */ }
  }
  const registration = await ctx.tool.hook("execute.before", (event) => {
    if (event.tool !== "shell" || typeof event.input?.command !== "string") return
    const input = event.input
    const rule = detect && (preflightPattern(input.command) || binaryPeek(input.command))
    if (rule) {
      record({ kind: "pattern", rule, mode })
      if (mode === "block") throw new Error(`toolcall-guard: refused shell call (${rule})`)
    }
    if (clamp && Number.isSafeInteger(ms) && ms > 0 && ms <= 2147483647 &&
        !Object.hasOwn(input, "timeout") && SCANLIKE.test(input.command)) {
      input.timeout = ms
      record({ kind: "clamp", ms })
    }
  })
  return registration && (() => registration.dispose())
}
