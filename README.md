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

Well-formed streams pass through **byte-identical**. With no environment
flags set, all logic stays in-process — no network calls, no extra files
beyond the three markers above. The optional lanes below (off by default)
talk to a **local** decision server and may send turn text to it; see each
lane's privacy note.

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

## Optional lanes (off by default)

Feature-flagged via environment; nothing below activates unless you set its
flag. They share one dependency: a [Rizzo Flow](https://github.com/Rizzo-AI-Academy/rizzo-flow)
decision server (local, Jev-compatible API, ~1.7 GB model) — if it is not
reachable, every lane fails open silently.

### Turn audit — "did the agent stop with work left?"

Observation only, **never injects**. On `session.idle` (when the clip
heuristic found nothing): a deterministic sieve exits question/offer-ended
turns for free, flags dangling ends, and the residue is scored by one
`whose move is next?` choice question on the decision server. Results
append to `toolcall-guard.audit` — a label stream for later calibration.

```bash
TOOLCALL_GUARD_AUDIT=1 opencode          # interactive thresholds
TOOLCALL_GUARD_AUDIT=overnight opencode  # alert-grade thresholds
```

### Preflight — blast-radius gate for bash

Deterministic, model-free: logs zero-ambiguity unbounded commands
(`rm -rf /`, `find ~`, `du $HOME`, … — quote-aware argv parsing, not
substring grep). `=block` additionally refuses them. Optional clamp sets a
timeout on scan-like commands that lack one (note: opencode's own default
is already 120s — set `TOOLCALL_GUARD_CLAMP_MS` deliberately, below your
effective `bashDefaultTimeoutMs`).

```bash
TOOLCALL_GUARD_PREFLIGHT=1 opencode      # log only
TOOLCALL_GUARD_PREFLIGHT=block opencode  # log + refuse
TOOLCALL_GUARD_CLAMP=1 opencode          # scan-like + no timeout -> clamp
```

### Confab scrub — strip invented conversation-state from replay

Some Qwen-family models intermittently emit reasoning blocks narrating a
conversation that doesn't exist ("the user's message is a system reminder…
no actual task", "no previous thinking to reproduce", a phantom `audit`
tool). opencode replays those blocks every turn, poisoning context. Tier 1
(14 battle-tested signature rules) replaces matching **reasoning** parts in
the outgoing request only — the database keeps originals, and the scrub is
retroactive: old contaminated sessions heal on resume. Text parts are
logged, never rewritten. Tier 2 (broad candidates + one decision-server
question) logs verdicts only.

```bash
TOOLCALL_GUARD_SCRUB=1 opencode          # log candidates only
TOOLCALL_GUARD_SCRUB=strip opencode      # + strip rule-matched reasoning
```

**Do not enable `strip` in sessions whose topic is the artifact itself** —
prose *about* confabulation matches the signatures (measured, both tiers).
Provider-scoped to `qwen|ds4` by default (`TOOLCALL_GUARD_SCRUB_PROVIDERS`).

### All flags

| Var | Values | Default |
|---|---|---|
| `TOOLCALL_GUARD_AUDIT` | unset \| `1` \| `overnight` | off |
| `TOOLCALL_GUARD_AUDIT_T` | number (probability cut) | 0.5 / 0.6 by mode |
| `TOOLCALL_GUARD_RIZZO` | decision-server URL | `http://127.0.0.1:8017/v1/systemone` |
| `TOOLCALL_GUARD_RIZZO_MODEL` | model id | `rizzo-flow-1.7b-q8_0` |
| `TOOLCALL_GUARD_PREFLIGHT` | unset \| `1` \| `block` | off |
| `TOOLCALL_GUARD_CLAMP` / `_CLAMP_MS` | `1` / ms | off / 120000 |
| `TOOLCALL_GUARD_SCRUB` | unset \| `1` \| `strip` | off |
| `TOOLCALL_GUARD_SCRUB_PROVIDERS` | regex | `qwen\|ds4` |
| `TOOLCALL_GUARD_CONFAB_LOG` | log path override | real log (tests point here) |

Privacy: the audit and scrub lanes send turn text (request + reply tail /
passage) to the configured URL — localhost by default, never remote unless
you point it there. Preflight logs command snippets; the confab log may
contain quoted reasoning snippets. All logs live under
`~/.local/share/opencode/toolcall-guard.*` (`audit`, `audit.shadow`,
`preflight`, `confab`, `clips`, `scrubbed`, `idles`, `errors`, `loaded`).

## Tests

```bash
node test/toolcall-guard.test.mjs        # 14 fixtures: guard, scrubber, detector
node test/turn-audit.test.mjs            # sieve + audit-state + wire shape
node test/preflight.test.mjs             # argv danger parsing (17 cases)
node test/confab.test.mjs                # rules, tiers, never-empty guard
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
  detected by the clip heuristic; the audit lane *measures* the residue but
  is observation-only until its calibration earns promotion.
- The audit lane cannot see "statement-shaped" stops whose unfinished work
  lives in plan state, not in the text — no text-only detector can.
- The decision model never outperforms its state: blast-radius judgment
  needs the filesystem, conclusion judgment needs the plan. Both are
  documented dead ends for command-text-only designs.
- User-aborted turns (esc) are never nudged or audited (race-free
  `step-finish` discriminator).
- Modes 2/3 are the **provider's** parser bug; the guard can only absorb
  their consequences, not prevent clipped replies.
- Scoped to opencode 1.x (AI-SDK runtime + plugin API); opencode v2 is not
  targeted.

## License

MIT
