const notice = "[toolcall-guard] binary output suppressed; use file or xxd -l 64 to inspect safely."

export async function setupBinary(ctx, helpers) {
  if (process.env.TOOLCALL_GUARD?.toLowerCase() === "off" || process.env.TOOLCALL_GUARD_BINARY !== "1") return
  const registration = await ctx.tool.hook("execute.after", (event) => {
    if (event.status !== "completed" || !Array.isArray(event.result?.content)) return
    const parts = event.result.content
    let content
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (part?.type !== "text" || typeof part.text !== "string" || !part.text.slice(0, 8192).includes("\0")) continue
      content ??= parts.slice()
      content[i] = { ...part, text: notice }
    }
    if (content) event.result = { ...event.result, content }
  })
  return registration && (() => registration.dispose())
}
