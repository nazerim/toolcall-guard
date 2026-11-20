# toolcall-guard

An [opencode](https://opencode.ai) plugin (1.x **and** 2.x) that stops
OpenAI-compatible providers from killing your session with:

```
Expected 'function.name' to be a string.
```

(`AI_InvalidResponseDataError`, thrown from the bundled
`@ai-sdk/openai-compatible` stream handler. On opencode 2.x the same
provider-side malformation instead surfaces as
`OpenAI Chat tool call delta is missing id or name` from its native handler,
or silently as clipped turns — see [Who needs this](#who-needs-this).)

## Who needs this

Any opencode user (1.x **or** 2.x) on a provider whose server parses
ChatML-native models (Qwen, DeepSeek, GLM, …) into OpenAI-style `tool_calls`
deltas:

- DashScope / Aliyun **token-plan** subscription endpoints (frequent)
- **vLLM** with `qwen3_xml` tool parser
- **llama.cpp** with certain parser flags
- NVIDIA NIM and other "OpenAI-compatible" gateways

Upstream history (re-verified 2026-11-20): the 1.x crash came from a stale
bundled `@ai-sdk/openai-compatible` in the compiled binary. Filed upstream as
[anomalyco/opencode#26412](https://github.com/anomalyco/opencode/issues/26412),
[#24137](https://github.com/anomalyco/opencode/issues/24137),
[#31295](https://github.com/anomalyco/opencode/issues/31295) (all closed —
"file against vercel/ai") and [#52462](https://github.com/anomalyco/opencode/issues/52462)
(closed `not_planned` by the v1-triage sweep; the v1 line still bundles the
pre-fix copy — 1.19.6 pins 2.0.37/2.0.41). The SDK was fixed by
[vercel/ai#18440](https://github.com/vercel/ai/issues/18440) → PR
[#18445](https://github.com/vercel/ai/pull/18445), which reworked the shared
`streaming-tool-call-tracker.ts` in `@ai-sdk/provider-utils` (deltas are
correlated to the open call by id+index+name and buffered until identity
resolves) — no-throw from `@ai-sdk/openai-compatible` **2.0.58** / **3.0.58**
(earlier drafts of this README said 3.0.62; the throw string survives for
truly unresolvable names). opencode 2.x meanwhile rewrote its own OpenAI-Chat
layer ([#37847](https://github.com/anomalyco/opencode/pull/37847) buffers
partial tool-call identity; [#48943](https://github.com/anomalyco/opencode/pull/48943)
aliased `@ai-sdk/openai-compatible` to the native impl), so the old message is
gone from 2.x binaries.

**The bug family is still live on opencode 2.x in our usage (2.3.2).** The
servers keep emitting the malformed fragments, and 2.x's native handler has
its own residual failure for unresolvable identity —
`OpenAI Chat tool call delta is missing id or name`
([#52700](https://github.com/anomalyco/opencode/issues/52700) /
[#53690](https://github.com/anomalyco/opencode/issues/53690), both closed
`not_planned`) — plus the silent mode-2/3 truncations no parser-side fix can
see (the clip lanes below still fire on our 2.x sessions). The stream guard
normalizes fragments before the parser runs, so it covers the 1.x SDK throw
*and* the 2.x native error. This plugin fixes it client-side today.

## What it does (three layers)

| Layer | Failure mode | Behavior |
|---|---|---|
| **Stream guard** (wraps each provider's `fetch`) | Server opens a `tool_calls` delta with `name:null` / missing id, or splits id/name across fragments → SDK throws → **turn aborts** | Buffers unknown-index fragments until id+name resolve, re-emits one valid opening fragment with merged args; trims backtick-wrapped names; coerces numeric ids; drops phantom calls that never resolve — the turn ends as plain text instead of dying |
| **Outbound scrubber** (`experimental.chat.messages.transform`) | opencode replays `reasoning_content`/text verbatim, so a leaked/truncated special-token pattern stays in history and **re-arms the server's parser every turn** | Rewrites `<\|name\|>` in outbound history to `< \|name\| >` — parser-inert, readable, idempotent, self-healing |
| **Auto-continue** (`event` on `session.idle`) | Server truncates generation at the pattern and closes with a clean `finish_reason:"stop"` — reply ends mid-sentence, **silently** | Detects clipped turns (stop + no tool call + empty or dangling-backtick text tail), sends one nudge ("your reply was truncated, resume from this tail, don't repeat"); once per message, max 3 per session, subagents skipped |
| **Binary-output guard** (`tool.execute.after`) | `cat` of a model file / image / compiled artifact — NUL-bearing bytes flood the context AND the TUI, and opencode's truncator spills the **full** stream to disk (one live incident: 27 GB from `cat *.gguf`) | Rewrites NUL-bearing outputs (first-8 KB window) into a short notice: printable excerpt, the spill-file path, and safe inspection commands (`file`, `xxd -l 64`, `strings`) |

Well-formed streams pass through **byte-identical**. The observation lanes
are **on by default** (a launch-line-env soak collected only 6 sessions
in 2 days — coverage demanded defaults): they write marker files and,
when a **local** decision server is reachable on `127.0.0.1`, send turn
text to it; model-backed lanes self-disable while the server is
unreachable. `TOOLCALL_GUARD=off` disables every optional lane; per-lane
`off`/`0` opts out individually. The stream guard + scrubber core is not
affected. See each lane's privacy note.

## Install

**V1 (opencode 1.x):**

```bash
mkdir -p ~/.config/opencode/plugins
cp plugins/toolcall-guard.js ~/.config/opencode/plugins/
```

(or drop it in a project's `.opencode/plugins/`). **Restart opencode** —
config and plugins load once at startup.

**V2 (opencode 2.x):** V2 loads plugin **package directories**, not bare
files — point the `plugins` config array at this repo's `plugin-v2/`
directory (absolute path, e.g. in the global `opencode.json`):

```jsonc
{ "plugins": ["/path/to/toolcall-guard/plugin-v2"] }
```

## OpenCode 2 (V2) support

Same core file, two entry shapes — because the runtimes are asymmetric and
both asymmetries were proven live (2026-10-22, opencode 2.1.2 vs 1.19.3):

- **V1 loads only a FUNCTION default export** (`plugins/toolcall-guard.js` —
  the documented 1.18.29+ object entry does NOT load in 1.19.3: the guarded
  crash resurfaces with zero plugin logs).
- **V2 loads only an OBJECT default export** with `{ id, setup }` — the
  function is skipped silently. `plugin-v2/index.js` is the V2 package
  directory; it builds the object from the core's `setup` property. No
  `@opencode/plugin` dependency needed.

V2 layers ported (env flags shared with V1):

| V1 hook | V2 destination |
|---|---|
| `config` (wrap each openai-compatible provider's `options.fetch`) | `ctx.session.hook("http.response")` — replaces `event.response` with the piped body; gated on SSE content-type only (the provider catalog is incomplete at plugin-boot, so an allowlist there races — and `handleLine` passes non-OpenAI lines byte-identical anyway) |
| `experimental.chat.messages.transform` | `ctx.session.hook("context"/"compaction"/"generate"/"title")` + `scrubStrings` (shape-agnostic deep walk covers V2 text/reasoning/tool-arg parts) |
| `event` on `session.idle` | `ctx.event.subscribe()` on **`session.execution.succeeded`** — V2's turn-complete event. The shared V2 service runs plugin setup once PER LOCATION and may also deliver the V1-compat `session.idle` per turn, so one event can reach several instances: nudges are guarded by an exclusive-create claim file per message (`toolcall-guard.nudge.<messageID>`), making double delivery a functional no-op (only the `idles` log doubles). Message shape via `ctx.session.context()` (`{data:[…]}` envelope; `finish` presence replaces the step-finish-part abort check) |

The six legacy lanes are ported as **opt-in** V2 lanes (off unless set;
V1's `0`/`off` also mean off). Details: [lane status](docs/v2-legacy-lanes.md),
[live vs fixture-only verification](docs/v2-port-queue.md).

| V2 flag (`TOOLCALL_GUARD_…`) | Values | Effect |
|---|---|---|
| (master) `TOOLCALL_GUARD` | `off` | disables all lanes + auto-continue; stream guard and scrubber stay |
| `PREFLIGHT` | `1`\|`log`\|`block` | log rule hits on `shell`; `block` refuses |
| `CLAMP` (+`CLAMP_MS`) | `1` (ms, default 120000) | timeout on scan-like commands lacking one |
| `BINARY` | `1` | NUL-bearing tool text → notice (model input only, not UI) |
| `SUBREPORT` | `log`\|`annotate` | empty/clipped child reports; `annotate` adds resume hint to outbound copy |
| `SCRUB` (+`SCRUB_JEV`) | `1`\|`log`\|`strip` (`1`) | confab rules; `strip` drops matched reasoning; `SCRUB_JEV=1` enables classifier tier |
| `AUDIT` (+`AUDIT_SEND`, `DANGLING`) | `1`\|`log`\|`overnight` (`1`, `nudge`) | turn audit; `AUDIT_SEND=1` sends text to classifier; `DANGLING=nudge` (not with `log`) queues one nudge |
| `JANITOR` | `1`\|`dry` | early delete (or count) of >1 GB, >24 h tool-output spills |

> **Warning:** V1-era exports in a shell profile (e.g. `TOOLCALL_GUARD_AUDIT=1`,
> `TOOLCALL_GUARD_SCRUB=strip`, `TOOLCALL_GUARD_JANITOR=1`,
> `TOOLCALL_GUARD_PREFLIGHT=block`) **now activate the V2 lanes** too. Unset
> them or set `TOOLCALL_GUARD=off` if you do not want that.

- The janitor sweeps **once per process** (startup; cross-process claim
  throttles to one sweep per 6 h). OpenCode itself already prunes tool-output
  spills after **7 days**, so enable it only under disk pressure.
- Audit with `AUDIT_SEND=1` sends the latest user request prefix and reply
  tail to the local (loopback) classifier; `SCRUB_JEV=1` sends reasoning
  passages. Without these second opt-ins nothing leaves the process.

V2 marker/log files land in `$XDG_DATA_HOME/opencode/` (the V1 default when
unset; `TOOLCALL_GUARD_DATA_DIR` overrides both). The V2 marker
(`toolcall-guard.loaded`) reads `{entry:"v2", providersWrapped:1,
openaiSeen:N, lanes:"on"|"off"}` — `providersWrapped:1` means the global
guard hook is registered (V2 wraps once per stream, not per provider);
`lanes:"off"` distinguishes a deliberate `TOOLCALL_GUARD=off` from a plugin
that never loaded. `TOOLCALL_GUARD=off` on V2 keeps the stream guard and
scrubber active and disables auto-continue plus every opt-in lane — the
same contract as V1 (unit-tested in `test/v2.test.mjs` and the
`test/v2-*.test.mjs` lane suites).

V2 quirks found while verifying (fixture + harness handle all of them):

- The V2 **title request embeds the raw user prompt** — any server-side
  "is this the main turn?" heuristic must key on something else (the
  fixture uses the presence of `tools`).
- `opencode run --standalone "<msg>"` stores the message **with literal
  quotes** around it.
- `ctx.provider.list()` / `ctx.session.context()` answer with a
  `{location, data}` / `{data}` envelope; provider.list() may also reject
  while the registry boots.
- The bash tool is named **`shell`** in V2 — the fixture auto-detects which
  name the harness offers.

Applies automatically to every provider whose `npm` is
`@ai-sdk/openai-compatible`. Verify via marker files:

```
~/.local/share/opencode/toolcall-guard.loaded     # plugin active, N providers wrapped
~/.local/share/opencode/toolcall-guard.scrubbed   # outbound history rewrites
~/.local/share/opencode/toolcall-guard.clips      # auto-continue firings
```

## Observation lanes (V1: on by default, `off` to opt out; V2: opt-in, see table above)

Feature-flagged via environment; nothing below activates unless you set its
flag. They share one dependency: a [Rizzo Flow](https://github.com/Rizzo-AI-Academy/rizzo-flow)
decision server (local, Jev-compatible API, ~1.7 GB model) — if it is not
reachable, every lane fails open silently. Setup, the two API endpoints'
exact shapes and gotchas, measured question-writing rules, and calibration:
**[docs/rizzo-notes.md](docs/rizzo-notes.md)**.

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
substring grep) and binary-peek (`cat`/`od`/`strings` of a
binary-extension file with no bounding pipe — one live `cat *.gguf`
spilled 27 GB to disk). `=block` additionally refuses them. Optional
clamp sets a timeout on scan-like commands that lack one (note:
opencode's own default is already 120s — set `TOOLCALL_GUARD_CLAMP_MS`
deliberately, below your effective `bashDefaultTimeoutMs`).

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

### All flags (V1 defaults; V2 values in the V2 section)

| Var | Values | Default |
|---|---|---|
| `TOOLCALL_GUARD` | `off` disables all optional lanes | on |
| `TOOLCALL_GUARD_AUDIT` | `off` \| `1` \| `overnight` | on (`1`) |
| `TOOLCALL_GUARD_AUDIT_T` | number (probability cut) | 0.5 / 0.6 by mode |
| `TOOLCALL_GUARD_RIZZO` | decision-server URL | `http://127.0.0.1:8017/v1/systemone` |
| `TOOLCALL_GUARD_RIZZO_MODEL` | model id | `rizzo-flow-1.7b-q8_0` |
| `TOOLCALL_GUARD_PREFLIGHT` | `off` \| `1` \| `block` | on (`1`) |
| `TOOLCALL_GUARD_CLAMP` / `_CLAMP_MS` | `1` / ms | off / 120000 |
| `TOOLCALL_GUARD_SCRUB` | `off` \| `1` \| `strip` | on (`1`) |
| `TOOLCALL_GUARD_BINARY` | `0` disables the binary-output guard (log path: `TOOLCALL_GUARD_BINARY_LOG`) | on |
| `TOOLCALL_GUARD_JANITOR` | `0` disables the startup sweep of >1 GB, >24 h tool-output spills | on |
| `TOOLCALL_GUARD_DANGLING` | `nudge` activates auto-continue on deterministic dangling-announcement stops (colon/em-dash ending + zero tool calls, main sessions, max 2/session); unset = log-only | log |
| `TOOLCALL_GUARD_LIVENESS_LOG` | redirect the guard-liveness warning (default: `toolcall-guard.errors`) | unset |
| `TOOLCALL_GUARD_SUBREPORT` | `off` \| log-only (unset) \| `annotate` (append fact + resume-with-task-id hint to empty/clipped subagent reports in the outbound copy) | log |
| `TOOLCALL_GUARD_SCRUB_PROVIDERS` | regex | `qwen\|ds4` |
| `TOOLCALL_GUARD_CONFAB_LOG` | log path override | real log (tests point here) |
| `TOOLCALL_GUARD_DATA_DIR` | absolute dir override for all markers/logs (wins over `XDG_DATA_HOME`) — pin it when a process might inherit the other install's env | unset |

Privacy: the audit and scrub lanes send turn text (request + reply tail /
passage) to the configured URL — localhost by default, never remote unless
you point it there. V2 restricts classifier endpoints to numeric loopback (`127.0.0.1` / `[::1]`, no credentials, query, fragment or redirects) and sends text only with `TOOLCALL_GUARD_AUDIT_SEND=1` (audit) or `TOOLCALL_GUARD_SCRUB_JEV=1` (confab). Preflight logs command snippets; the confab log may
contain quoted reasoning snippets. All logs live under
`~/.local/share/opencode/toolcall-guard.*` (or `$XDG_DATA_HOME/opencode/`
when set — the V2 install) (`audit`, `audit.shadow`,
`preflight`, `confab`, `clips`, `scrubbed`, `idles`, `errors`, `loaded`, `binary`, `janitor`,
plus `nudge.<messageID>` / `nudge.dangling.<messageID>` and V2 `audit-nudge.<sha256>` claim files (exclusive-create tokens
guarantee one nudge per message across all plugin instances — the V2 service runs setup once
per location and every instance sees every shared-stream event).

## Tests

**Stream liveness on V2 (verified with installed OpenCode 2.3.2):** the old
`zero SSE streams intercepted` warning used V1's `options.fetch` heuristic
inside V2's `http.response` hook. On V2 the counter measured responses, not
model calls; 25 ordinary JSON responses sufficed to trigger the warning.
It did not prove bypass. V1 retains its heuristic. V2 now records the 25th
successful non-SSE response as informational (`toolcall-guard.stream-info`),
and reports HTTP errors, invalid responses, missing SSE bodies, or wrapping
failures separately in `toolcall-guard.errors` (once per reason per setup).
These observations cannot detect a hook that is never invoked.

`python3 test/isolated-v2.py` runs a loopback late-name fixture through
`opencode run --standalone` with fresh HOME/XDG paths, an allowlisted child
environment and only the fixture provider enabled. It requires the actual
repair marker (`TOOLCALL_GUARD_V2_DEBUG=stream`, no payloads), a tool result
with `GUARD_OK` on the next request, and the final `ALL_DONE` reply. The
private fixture directory is removed after the run.

```bash
for t in test/*.test.mjs; do node $t; done   # unit suites, incl. test/v2.test.mjs
                                              # (entry shapes, analyzeMessagesV2,
                                              #  guardSseResponse, deep scrub)
```

End-to-end against a synthetic malformed SSE server (no real API needed):

```bash
# V1
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

**V2** — one script per harness (isolated XDG triple + standalone server;
requires `OPENCODE_V2_BIN` if opencode 2 is not at the default path):

```bash
zsh test/e2e-v2-matrix.sh        # late/drop/poison/clip via run --standalone
zsh test/e2e-v2-clip-serve.sh    # clip nudge round-trip on a persistent serve
```

The V2 fixture config (`test/toolcall-guard-test.v2.opencode.json`) is the
`plugins`-array twin of the V1 test config. The fixture auto-detects the
harness generation (tools → V2 `shell` vs V1 `bash`) and excludes the V2
title request from scenario serving — see the V2 support section.

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
- V2 support covers the core plus opt-in lanes; several V2 lanes are
  verified only against fixtures/mocks (see `docs/v2-port-queue.md`).

## License

MIT
