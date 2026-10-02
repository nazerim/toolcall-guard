# Running the decision lane: Rizzo Flow notes

The optional lanes (`TOOLCALL_GUARD_AUDIT`, `TOOLCALL_GUARD_SCRUB` Tier 2)
talk to a local [Rizzo Flow](https://github.com/Rizzo-AI-Academy/rizzo-flow)
server — a small fine-tuned decision model exposing the TypeSafe Jev
wire format. Everything here was measured, not copied from docs (the repo's
own `examples/` and `request.schema.json` are stale in places — see Gotchas).

## Bring up the server

```bash
git clone https://github.com/Rizzo-AI-Academy/rizzo-flow && cd rizzo-flow
uv sync --locked
uv run rizzo download --size 1.7b     # ~1.7 GB GGUF + llama.cpp runtime
uv run rizzo serve --size 1.7b --device metal   # macOS GPU (or: --device cpu)
curl -s 127.0.0.1:8017/health         # {"status":"ready",...}
```

Practical numbers (Apple Silicon, 1.7B-Q8): ~2.5 GB resident, ~0.1–0.2 s per
decision, one resident model with requests serialized. The 4B tier exists
but measured **worse** than 1.7B on turn-completeness and confab tasks —
bigger is not better for these questions; keep 1.7B unless your own battery
says otherwise. If the server is down, this plugin fails open: sessions are
unaffected, lanes simply produce nothing.

## The two endpoints are NOT the same API

### `/v1/systemone` — Jev-compatible (what this plugin uses)

```jsonc
{
  "model": "rizzo-flow-1.7b-q8_0",          // required here; get it from /v1/models
  "state": { "user_request": "...", "assistant_final": "..." },
  "questions": {                             // MUST be a named map
    "q": {
      "type": "choice",                      // noul | choice | score
      "instructions": "After this message, whose move is next?",
      "criteria": { "assistant": "...", "user": "...", "nobody": "..." }
    }
  }
}
```

Gotchas (each one earned a 422):

- `questions` is a map of `{id: question}` — never a bare question object.
- Live question types are `noul|choice|score`. The repo's `examples/*.json`
  and `request.schema.json` still say `boolean` — do not trust them.
- `noul` accepts only `{type, instructions}` (+ optional `policy`).
  `true_description`/`false_description` are rejected.
- `choice`/`score` use `criteria`: an `{id: description}` dict / an ordered
  level list. Descriptions are **required in practice** — the model never
  sees bare ids.
- Omitting `"model"` → 422.

### `/v1/decisions` — native (stricter, richer)

- **No `model` field** (strict schema; unknown fields 422).
- `choice` uses `options: [{id, description}]`, `score` uses `levels: [...]`,
  the binary type is `boolean`.
- Adds per-question `policy`: `allow_abstain`, `min_top_probability`,
  `max_unavailable_probability` → per-answer `status:
  ok|uncertain|insufficient_evidence`.
- Adds per-answer `uncertainty: {top_probability, entropy_nats,
  concentration}`. Entropy proved a genuinely useful independent signal
  (measured AUC ~0.69 where the choice probability ~0.75 on the same task).
- Probabilities from the two endpoints are not interchangeable at a fixed
  threshold: enabling abstention renormalizes the option masses. Retune if
  you switch.

## Question-writing rules (measured on labeled turn corpora)

1. **Surface beats mental state.** "Does this message end by asking the user
   a question?" separated cleanly (0.82 vs 0.12); "Is the agent *waiting*
   for a reply?" blurred (0.46 vs 0.31). Ask about properties of the text,
   not intentions of the agent.
2. **Visible verbs and quoted cues win.** Putting example phrasings in the
   option description ("says 'Now I will…', 'Let me…'") measurably improved
   recall, including catching a stall family the short phrasing missed.
3. **One normalized `choice` beats several `noul`s.** Independent nouls can
   contradict each other (0.47 "asks" + 0.66 "promises" on the same turn);
   options in one choice compete in a single softmax.
4. **Never treat 0.5 as meaningful on uncalibrated scores** — a named
   anti-pattern in the vendor's own docs (shared-prefix near-ties flip).
5. **Two question-variant rounds max, then freeze.** On small eval sets
   (n≈70–200), deltas under ~4 points are noise; further tuning is fitting
   the eval.
6. **The model cannot count.** A numeric `tool_calls: 3` field in state
   changed nothing; evidence must be rendered as text facts.
7. **Know your state ceiling.** The model scored ~0.01–0.05 for "wide scan"
   on any bash command: blast radius lives in the filesystem, not the
   command text. Some questions need richer state, not a bigger model —
   and some answers are "use a deterministic rule instead."

## Calibration (built in)

```bash
# jsonl of labeled decisions from your own domain:
uv run rizzo calibrate calibration.jsonl --fingerprint <x_rizzo.fingerprint> --output fit.json
uv run rizzo serve --size 1.7b --device metal --calibration fit.json
```

Temperature scaling per primitive, bound to a fingerprint
(weights + precision + runtime + backend + prompt version): a fit does not
survive changing the model or runtime. Until you calibrate, treat scores as
rankings, not probabilities — which is exactly why this plugin's audit lane
starts observation-only and thresholds are labeled "uncalibrated" in the
response metadata (`x_rizzo.probability_status`).

## What this plugin sends to the server

Audit lane: the last user message (≤1200 chars) + final assistant text tail
(≤800 chars). Confab Tier 2: the candidate reasoning passage (≤1500 chars).
localhost by default; `TOOLCALL_GUARD_RIZZO` lets you point elsewhere —
don't, unless you mean to.

## Known limit: deferred-work FPs (audit lane)

The W2d question's "lists work that remains undone" clause does not
distinguish work the agent owes **now** from work that is scheduled
(cron), blocked (needs data/prereqs), or a documented backlog. Live soak
(2026-10-02): 3 independent FPs of this shape, scores 0.52–0.92 —
indistinguishable from a true stall by score alone at any threshold.
Attempts: negation-scoped question (fixed FPs, collapsed the true
positive into a 0.03 margin — noise); two-question cascade (worse, 3/5).
Conclusion at the 1.7B's noise floor: **accepted as a known limit while
the lane is observation-only**; revisit with larger labeled sets or
richer state (e.g., including the turn's own tool activity, so claims
like "all pushed" are verifiable). Deterministic half of the veto-idiom
case ("unless you object" = user's move) is fixed in the OFFER sieve.
