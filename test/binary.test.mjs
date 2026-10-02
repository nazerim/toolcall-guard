import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import plugin from "../plugins/toolcall-guard.js"

const { binaryGuard } = plugin.__test
process.env.TOOLCALL_GUARD_BINARY_LOG = "/tmp/toolcall-guard-binary.test.log"

const GGUFISH = "GGUF\x00\x00\x00\x03" + "\x9a\x01\x00\x00\x00\x00\x00\x00" + "vocab\x00tokenizer.ggml.tokens" + "\x00".repeat(40) + "binaryjunk\x03\x04"
const input = { tool: "bash", sessionID: "ses_test", args: { command: "cat ds4flash.gguf" } }

// NUL-bearing output is suppressed and replaced with an actionable notice
{
  const output = { title: "cat ds4flash.gguf", output: GGUFISH + "\nFull output saved to: /tmp/tool_abc", metadata: {} }
  assert.equal(binaryGuard(input, output), true)
  assert.ok(output.output.includes("binary output suppressed"))
  assert.ok(!output.output.includes("\0"))
  assert.ok(output.output.includes("/tmp/tool_abc"))
  assert.ok(output.output.includes("xxd -l 64"))
}

// plain text (even with tabs/newlines/CR) is untouched
{
  const text = "Makefile:22:DS4_TEST_MODEL ?= ds4flash.gguf\n\ttab\there\r\nnothing binary"
  const output = { title: "grep", output: text, metadata: {} }
  assert.equal(binaryGuard(input, output), false)
  assert.equal(output.output, text)
}

// NUL past the 8 KB head window is opencode-truncator territory, not ours: no-op
{
  const output = { title: "t", output: "x".repeat(9000) + "\0", metadata: {} }
  assert.equal(binaryGuard(input, output), false)
}

// kill switch: TOOLCALL_GUARD_BINARY=0 disables the lane (env read at load)
{
  const probe = `
    import plugin from ${JSON.stringify(fileURLToPath(new URL("../plugins/toolcall-guard.js", import.meta.url)))}
    const o = { output: ${JSON.stringify(GGUFISH)} }
    process.exit(plugin.__test.binaryGuard({ tool: "bash", args: {} }, o) ? 1 : 0)
  `
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    env: { ...process.env, TOOLCALL_GUARD_BINARY: "0" },
  })
  assert.equal(r.status, 0)
}
