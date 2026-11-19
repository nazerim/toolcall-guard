# V2 optional behavior ports

Target: the installed OpenCode 2.3.2 runtime. See [legacy evidence and flags](v2-legacy-lanes.md). Every port is opt-in; a normal V2 launch must not change behavior.

| Port | Acceptance check | Verified live on 2.3.2 vs fixture-only |
|---|---|---|
| Stream repair (core) | Repair malformed tool-call streams; pass well-formed streams unchanged. | **Live e2e** (`test/isolated-v2.py`, `e2e-v2-matrix.sh`). |
| Shell preflight | Observe, clamp or block only as configured; preserve explicit timeouts and avoid logging the command. | **Live e2e** for `log`, `block` and `CLAMP` (`test/e2e-v2-preflight.py`). |
| Binary output | Suppress NUL-bearing text; preserve ordinary text and typed media. | **Live e2e for model input only** (next request carries the notice, no NUL). UI rendering not verified; a post-hook cannot retract streamed output. |
| Child reports | Distinguish completed reports from asynchronous acknowledgements and cancellations; annotate only the outbound copy. | Fixture/mocks only. Unverified: synthetic subagent message `metadata.childID`/`state`/`description` shape in `session.context`. |
| JEV confab | Scope by provider and role, bound classifier traffic, preserve visible content; distinguish observation from stripping. | Fixture/mocks only. Unverified: `event.model` (`providerID`/`id`) present on the `context` hook. |
| Turn audit | Bound classifier activity; distinguish observation from a nudge, deduplicate terminal events and respect child/cancellation state. | Fixture/mocks only. Unverified: idle marker id = event id with `evt_`→`msg_`; `event.created` in ms; `ctx.location.directory` / `session.location.directory`; `session.prompt` accepting `delivery: "queue"` and a caller `id`. |
| Spill janitor | Check actual V2 file ownership/layout. Exercise age, size, active-file and symlink exclusions on disposable fixtures only. | Fixture only (disposable dirs). Layout/id format checked against 2.3.2 binary strings and source `f870161`, not by a live sweep. |

Integration gate: test the real V2 entrypoint with flags unset, master-off and individual opt-ins. Exercise meaningful hook paths with isolated fixtures, run the unit suites and malformed-stream e2e, then obtain independent review. Record unsupported runtime behavior explicitly. Until the unverified assumptions above are confirmed live, those lanes may silently do nothing on 2.3.2.
