# V2 stream-guard coverage in subagent sessions (2026-11-20)

## Report

"the V2 plugin does not trigger in subagents" (and, per `../TODO.md`, "never
intercepts SSE streams, main AND subagent sessions").

## Finding: no subagent bypass exists — the guard was running all along

Evidence, in order of strength:

1. **Live observer (2.3.2, shared service, 2026-11-20 23:45–23:51, since
   removed).** A temporary `http.response` observer registered before the core
   hook recorded, for each model call, the session and the response the core
   then replaced:

   ```
   before n=2 kind=primary sessionID=ses_e0668d90… agent=general  ct=text/event-stream status=200
   after  n=2 sessionID=ses_e0668d90… replaced=true bodySame=false
   ```

   `ses_e0668d90…` is a **child** session (agent `general`, parent
   `ses_e067e829…`), i.e. a subagent. Root sessions (`agent=build`) behaved
   identically. `replaced=true` is the core's own wrapper
   (`plugins/toolcall-guard.js:200-225`) swapping `event.response`.

2. **Source (tag `v2.3.2`).**
   - Hooks are registered per **Location**, not per session:
     `packages/core/src/plugin/hooks.ts:69-102,108` (register/trigger/has —
     scope + provider matching); `plugin/host.ts:568` forwards
     `session.hook → hooks.register`.
   - Every model call — root or child — goes through the same
     `SessionModelRequest.prepare`, which triggers `http.response` for the
     session that asked: `packages/core/src/session/model-request.ts:278`
     (`scope = { sessionID, agent, model, kind }`), `:375-377` (`hasHttpHooks`
     gate), `:396-404` (trigger + `HttpClientResponse.fromWeb(sent,
     after.response)`).
   - Subagents are ordinary child sessions: `sessions.create({ parentID })`
     then `sessions.prompt(...)` in
     `packages/core/src/tool/plugin/subagent.ts:171-202`. Nothing forks the
     dispatch path, the process, or the location.
   - An unscoped registration (`ctx.session.hook(name, cb)` with no
     `{ providerID }`) satisfies the gate for every provider:
     `hooks.ts:97-102` (`entry.options?.providerID === undefined || …`).

3. **Why it looked dead.** The only positive marker was
   `reason:"repaired"`, written **only** when
   `TOOLCALL_GUARD_V2_DEBUG=stream` (`plugins/toolcall-guard.js:1304-1308`).
   `non-sse` is written once per process, on the 25th non-SSE response
   (`:1314-1315`), and counts *every* kind — title/compaction/generate/
   decision calls answer JSON by design. So a working guard leaves a file that
   reads like "zero interceptions". The 2026-11-18 `guard-liveness` line
   cannot come from the V2 core at all: `LIVE.requests` is only incremented in
   the V1 `messages.transform` hook (`:1096`), which V2 never registers.

## Fix (`plugin-v2/stream-report.js`, new lane)

A coverage marker for the core: read-only, registered **before** the core
(first lane in `plugin-v2/index.js`, but `{ setup: plugin.setup, fatal: true }`
keeps fatality with the core — an observer failure may never take the guard
down, and vice versa the observer may never replace the core as the fatal
lane). It is an ordinary **lane**: `TOOLCALL_GUARD=off` disables it (the core
guard itself is unaffected, as always).

Writes to `toolcall-guard.stream-info`, capped at **12 lines total per module
instance** — the counter is module-scoped (shared across Locations/setups and
includes the deferred verification writes), so a long-lived process stays
bounded; a hot re-import of the module re-arms the budget.

| reason | when |
|---|---|
| `sse-seen` | this reporter saw a `primary` SSE response in the hook (sessionID, kind, status) — the core registers for the same events, but this line alone does not prove the core ran |
| `response-replaced` | a hook registered after this one replaced `event.response` by the next macrotask (with the core guard configured, that replacer is the core; attribution is not proven, and a later-resolving replacer is missed — under-report only) |
| `non-sse-primary` | a `primary` response was not SSE — worth investigating, but not the only possible miss (active WebSocket frames never reach `http.response`) |

Non-primary kinds are ignored, so JSON from title/compaction/generate/
decision endpoints can no longer masquerade as a guard miss. A root or child
session is visible by `sessionID`.

## Residual gaps (stated plainly)

- **Auto-continue / turn-audit nudges still skip child sessions** — V1 policy,
  deliberate (`plugins/toolcall-guard.js:1388`, `plugin-v2/audit.js:192-200`).
- **Active WebSocket frames** (OpenAI / xAI / Azure Responses on native WS)
  bypass `http.response`; only `experimental.ws.handshake|send|receive` see
  that traffic. Note the WS *fallback* still runs through the HTTP hooks
  (`model-request.ts:407-408`), so the gap is live WS frames only. Not
  covered; rewriting frames is a separate, riskier change and no configured
  provider here uses it.
- **Positive proof is observational**: `response-replaced` confirms a
  replacement happened downstream, not that it was the guard's, and not byte
  identity of the guarded body. The `repaired` marker (debug-gated) remains
  the only core-owned, attributional signal; promoting it to always-on is the
  natural follow-up if stronger proof is ever needed.

## Live reload

Observed 2026-11-20: `toolcall-guard.loaded` mtime and new
`v2-stream-report` lines moved at 23:51–23:52 while the service process
(pid 50220, started Nov 19 13:50) kept serving — i.e. the V2 service reloaded
the `plugin-v2/**` change **without a restart** (the "restart after plugin
edit" law is V1 behavior; V1 still requires it). The shared 12-line budget
resets when a reload re-instantiates the module; exact reload semantics are
not otherwise characterized.
