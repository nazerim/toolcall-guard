# toolcall-guard

An [opencode](https://opencode.ai) plugin (1.x) that stops OpenAI-compatible
providers from killing your session with:

```
Expected 'function.name' to be a string.
```

(`AI_InvalidResponseDataError`, thrown from the bundled
`@ai-sdk/openai-compatible` stream handler.)

## Who needs this

Any opencode 1.x user on a provider whose server parses ChatML-native models
(Qwen, DeepSeek, GLM, …) into OpenAI-style `tool_calls` deltas:

- DashScope / Aliyun **token-plan** subscription endpoints (frequent)
- **vLLM** with `qwen3_xml` tool parser
- **llama.cpp** with certain parser flags
- NVIDIA NIM and other "OpenAI-compatible" gateways

Reported upstream as [anomalyco/opencode#26412](https://github.com/anomalyco/opencode/issues/26412),
[#24137](https://github.com/anomalyco/opencode/issues/24137),
[#31295](https://github.com/anomalyco/opencode/issues/31295) — all closed
(duplicates / "file against vercel/ai"). Vercel fixed the SDK
([vercel/ai#18440](https://github.com/vercel/ai/issues/18440) → PR #18445; the
throw string is gone in `@ai-sdk/openai-compatible@3.0.62`), but opencode 1.x
ships a **stale bundled copy** inside its compiled binary, so the crash is
still live. Everyone's tracker says "not ours". This plugin fixes it client-side
today.

## What it does (three layers)

| Layer | Failure mode | Behavior |
|---|---|---|
| **Stream guard** (wraps each provider's `fetch`) | Server opens a `tool_calls` delta with `name:null` / missing id, or splits id/name across fragments → SDK throws → **turn aborts** | Buffers unknown-index fragments until id+name resolve, re-emits one valid opening fragment with merged args; trims backtick-wrapped names; coerces numeric ids; drops phantom calls that never resolve — the turn ends as plain text instead of dying |
| **Outbound scrubber** (`experimental.chat.messages.transform`) | opencode replays `reasoning_content`/text verbatim, so a leaked/truncated special-token pattern stays in history and **re-arms the server's parser every turn** | Rewrites `<\|name\|>` in outbound history to `< \|name\| >` — parser-inert, readable, idempotent, self-healing |
| **Auto-continue** (`event` on `session.idle`) | Server truncates generation at the pattern and closes with a clean `finish_reason:"stop"` — reply ends mid-sentence, **silently** | Detects clipped turns (stop + no tool call + empty or dangling-backtick text tail), sends one nudge ("your reply was truncated, resume from this tail, don't repeat"); once per message, max 3 per session, subagents skipped |

Well-formed streams pass through **byte-identical**. No network calls of its
own; all logic is local.

## Install

```bash
mkdir -p ~/.config/opencode/plugins
cp plugins/toolcall-guard.js ~/.config/opencode/plugins/
```

(or drop it in a project's `.opencode/plugins/`). **Restart opencode** —
config and plugins load once at startup.

Applies automatically to every provider whose `npm` is
`@ai-sdk/openai-compatible`. Verify via marker files:

```
~/.local/share/opencode/toolcall-guard.loaded     # plugin active, N providers wrapped
~/.local/share/opencode/toolcall-guard.scrubbed   # outbound history rewrites
~/.local/share/opencode/toolcall-guard.clips      # auto-continue firings
```

## Tests

```bash
node test/toolcall-guard.test.mjs        # 14 fixtures: guard, scrubber, detector
```

End-to-end against a synthetic malformed SSE server (no real API needed):

```bash
SCENARIO=late PORT=8787 node test/toolcall-guard-server.mjs &
OPENCODE_CONFIG=$PWD/test/toolcall-guard-test.opencode.json \
  opencode run --auto -m guardtest/guardtest-model "say hi MARKER7788"
```

- `--pure` (plugin disabled) reproduces the fatal error — RED
- without `--pure` the call is repaired and the tool executes — GREEN
- `SCENARIO=drop` → phantom call dropped, graceful text-only turn
- `SCENARIO=poison` → token in history scrubbed from the replayed request
- `SCENARIO=clip` → clipped turn auto-nudged and resumed (use `opencode serve`
  + HTTP API so the nudge isn't raced by `run` exiting)

The server fixture builds token strings by concatenation — the repo itself
stays parser-inert, because these files were authored *through* the failing
endpoint.

## Known limits

- Silent truncation that ends cleanly mid-word (no dangling backtick) is not
  detected by the heuristic — a cheap classifier pass over the response tail
  would close this; the hook point is `analyzeMessages()`.
- Modes 2/3 are the **provider's** parser bug; the guard can only absorb
  their consequences, not prevent clipped replies.
- Scoped to opencode 1.x (AI-SDK runtime + plugin API); opencode v2 is not
  targeted.

## License

MIT
