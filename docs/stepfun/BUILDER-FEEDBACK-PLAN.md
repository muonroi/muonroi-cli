# StepFun Builder Program — feedback plan (muonroi-cli)

Sponsorship: 1 month Step Pro Plan, started **2026-09-03**, StepFun UID `400878669599649792`.
What StepFun asked for, verbatim: *"explore it in real-world projects and share what works
well, where it falls short, and what you'd like to see next."*

muonroi-cli is a useful probe for them because it is not a chat wrapper: it drives the model
through multi-turn tool loops, history compaction, a multi-agent council, and a full
plan→implement→verify pipeline. Those surfaces break models in ways a chat benchmark cannot see.

## Where to send it

| Channel | Use for |
|---|---|
| Discord `https://discord.gg/znyuN8cew` | model feedback — the enrolment mail puts *"send feedback directly to the StepFun team"* in this paragraph |
| `builders@stepfun.com` | account / access / product issues only, per the mail |

Cadence: **one report per week**, each closing out the checklist items finished that week.
Send the finished items only — an item with no evidence line is not ready to send.

## Ground rules for every item

- One concrete reproduction per finding: exact request, exact response, measured numbers.
- Separate **their bug** from **our bug**. The first real 400 this month was ours, not theirs
  (see D1-4); shipping that as a StepFun bug would have burned credibility.
- Distinguish *model* behaviour from *serving* behaviour — they are different teams.
- Prefer a minimal curl repro over "muonroi-cli does X"; they cannot run our CLI.

## Environment (so results are reproducible on their side)

- Base URL **`https://api.stepfun.ai/step_plan/v1`** — subscription plans do NOT bill through
  the default `/v1`. See D6-1.
- Models exercised: `step-3.7-flash` (premium/leader), `step-3.5-flash`, `step-3.5-flash-2603`.
- Harness: muonroi-cli agent-mode driven over its MCP harness (`tui.*` tools), so every
  observation is from a real TUI session, not a synthetic script.

---

# Week 1 — API contract, tool-calling, agentic loop

## D1 — Tool calling (highest value; this is where agentic use dies)

- [x] **D1-1** Single tool call, valid schema → correct `tool_calls` shape.
      *Evidence:* `finish_reason: "tool_calls"`, `{"city": "Hanoi"}` well-formed.
- [x] **D1-2** Parallel tool calls in one assistant message (2+) → accepted on replay.
      *Evidence:* 2-call and 3-call histories both 200. Notable: several other providers in
      this CLI (Z.ai, opencode-go) reject parallel calls in history; StepFun does not. **Works well — say so.**
- [x] **D1-3** Completed tool cycle + new user turn (multi-turn history) → 200.
- [x] **D1-4** Malformed `arguments` (JSON string, not object) → **HTTP 400
      `No filter named 'fromjson' found`**. *This one is ours to fix and theirs to harden.*
      Our compactor emitted a non-object; fixed in `subagent-compactor.ts`. But their side
      should be reported: the Jinja chat template calls a `fromjson` filter that is **not
      registered in the template environment**, so the branch can never succeed — and the
      error surfaces as an internal template name, not "invalid tool_calls.arguments".
      *Ask for:* schema validation on `arguments` with a caller-actionable message.
- [x] **D1-5** Empty-object schema and deeply-nested schema both handled correctly.
      *Evidence:* `parameters: {}` → `arguments` `"{}"`; nested object + `enum` + integer array →
      `{"svc": {"name": "api", "env": "prod", "ports": [80, 443]}}`. **Works well — say so.**
- [x] **D1-6** **`tool_choice` is ignored entirely. Highest-severity finding this week.**
      Deterministic across 3 repeats on `step-3.7-flash` and reproduced on `step-3.5-flash`:
      | `tool_choice` | Spec requires | Observed |
      |---|---|---|
      | `"none"` | must NOT call a tool | called `get_weather` (3/3 + 3.5-flash) |
      | `"required"` | must call a tool | returned prose, no call (3/3 + 3.5-flash) |
      | `{type:"function",function:{name:"ping"}}` | must call `ping` | called `get_weather` (3/3 + 3.5-flash) |
      Every case behaves exactly as if the field were absent — the model always decides for itself.
      *Impact on agentic use:* `"none"` being ignored is the dangerous one — a framework that
      disables tools for a final-answer or summarisation turn still gets tool calls back, which
      can prevent a loop from ever terminating. `"required"` and named forcing being ignored
      breaks forced-extraction and routing patterns.
      *Ask for:* implement `tool_choice`, or reject it with 400 so callers can detect it —
      silently accepting and ignoring is the worst of the three options.
- [x] **D1-7** Message-integrity validation is **permissive**: an orphan tool message with no
      prior call, a dangling `tool_calls` with no result, and a `tool_call_id` mismatch all
      return 200. OpenAI 400s on these.
      *Framing worth sending:* strictness is inconsistent — permissive about message
      *structure*, but a hard 500-class template crash on a non-object `arguments` (D1-4).
      Ideally invert it: validate `arguments` with a clear 400, stay lenient on history shape.

## D2 — Reasoning budget (already a real usability trap)

- [x] **D2-1** Output budget is consumed by reasoning before any `content`.
      *Evidence (step-3.7-flash, identical prompt):*
      | `max_tokens` | `content` | `finish_reason` |
      |---|---|---|
      | 64 | `""` | `length` |
      | 256 | `""` | `length` |
      | 1024 | `"Write memoized version of fib.js"` | `stop` |
      *Impact:* any short-output call path (classifiers, routers, title generation, structured
      verdicts) silently returns empty string rather than an error. muonroi-cli survives only
      because it already budgets 2048 for reasoning models.
      *Ask for:* either a separate reasoning budget knob, or `finish_reason: "length"` plus a
      distinguishable signal that the cut happened inside reasoning; ideally a documented
      minimum viable `max_tokens` per model.
- [x] **D2-2** **`reasoning_effort` works — and it changes the D2-1 ask.** Same prompt,
      `step-3.7-flash`:
      | `reasoning_effort` | reasoning | output tok | latency |
      |---|---|---|---|
      | unset | 4,395 ch | 1,042 | 16.8 s |
      | `low` | 110 ch | 102 | 4.9 s |
      | `medium` | 618 ch | 187 | 5.3 s |
      | `high` | 4,017 ch | 951 | 16.0 s |
      The knob exists, spans 40x, and **the default behaves like `high`**. So D2-1 is not
      "there is no budget control" — it is "the control is undocumented and defaults to the most
      expensive setting". `low` is a 3.4x latency win on short-output calls.
      *Ask for:* document it, and consider a cheaper default. *Our action:* set
      `reasoning_effort: "low"` on muonroi-cli's classify/title paths.
- [ ] **D2-3** Does reasoning length scale with prompt difficulty, or is it near-constant?

## D3 — Long-horizon agentic loop (their "real-world projects" ask)

- [x] **D3-1** End-to-end coding task through the real CLI binary: read → write → run → report.
      *Evidence:* correct memoized rewrite; independently re-ran its own benchmark, both
      implementations returned `832040`, ~200x speedup. Numbers it reported were real, not invented.
- [x] **D3-2** **Claim-vs-artifact gap — RETRACTED as a model finding. Does not replicate.**
      Originally logged from one `/ideal` run where the model narrated two fixes
      (*"Fix the `listen` helper"*, *"Also fix `request()` to use the stored port"*) that the
      emitted code did not contain — it renamed the variable at the definition (`listenPort`)
      but not at the use site, leaving an undeclared `port`. Measured then: 6 pass, 8 fail,
      `ReferenceError: port is not defined`, `ERR_SERVER_ALREADY_LISTEN` x7, exit 124.
      **Replication attempt: 4 controlled headless tasks, 4/4 claims matched the artifact.**
      | Task | Shape | Model claimed | Independently measured |
      |---|---|---|---|
      | T1 | off-by-one fix + regression tests | 4 pass / 0 fail | 4 pass / 0 fail, fix correct |
      | T2 | async retry+backoff + tests | 3 pass / 0 fail | 3 pass / 0 fail |
      | T3 | refactor, keep existing tests green | 3 pass / 0 fail, test file untouched | 3 pass / 0 fail, no diff to test file |
      | T4 | HTTP ETag + integration tests on an ephemeral port | 3 pass / 0 fail | 3 pass / 0 fail, exits cleanly |
      T4 deliberately reproduced the original's shape (HTTP server, `listen(0)`, real requests)
      and still matched. So the failure is not a general inability to apply an edit it describes.
      **Confounder we cannot rule out, and it is ours:** the original ran inside `/ideal`'s nested
      research sub-agent on a long history, and our sub-agent compactor replaces tool-call
      `arguments` with a placeholder — for a `write_file` call that *is the file content the
      model wrote*. A captured wire body from another long run shows exactly this elision. If it
      fired there, the model was regenerating a file it could no longer see. We cannot confirm
      it did: the compactor mutates the in-memory array before the call, so `messages` in the DB
      keeps full content and carries no elision marker (verified: 0 rows DB-wide).
      **Do not send to StepFun.** Re-test by re-running `/ideal` behind the capture proxy and
      checking whether `write_file` arguments are elided while the model is still iterating.
- [x] **D3-3** `/ideal` **does** reach implementation and produces working code. Second run,
      same task, behind a capture proxy with `MUONROI_LOOP_PROFILE=1`:
      93 requests, **0 failures, 0 elisions**, largest body 109 KB. It committed
      `43a8c22 feat: add per-user rate limiting (60 req/min sliding window)` and the artifact is
      **better than the first attempt**: `prune` uses an index scan plus one `splice(0, i)`
      instead of a `shift()` loop, and `Math.max(retryAfter, 1)` guards against emitting
      `Retry-After: 0`. Independently measured: **4 pass / 0 fail, exit 0, no hang.**
      This is a third independent data point against the retracted D3-2.
      The verify *stage* still did not run — see below.
- [x] **D3-3b** **The `/ideal` wedge reproduces (2/2) and is now precisely localised. Ours.**
      Measured at the second wedge:
      - the last API call **completed 200** (request #93, 37,824 bytes) — StepFun answered;
      - **0 established TCP connections** afterwards, so nothing was in flight;
      - CPU +0.32 s over 20 s (~1.6%) — not spinning;
      - `MUONROI_LOOP_PROFILE=1` **armed** (`debug.log`: `"profiler":"on"`) and **never fired**,
        which is the expected result: the profiler only triggers on a *blocked* event loop;
      - typing into the composer still advanced the frame (seq 420 → 421), so the event loop,
        the renderer and input handling are all alive — only the `/ideal` turn is stuck;
      - `Escape` produced no toast, no halt and no frame change: the abort path does not reach
        the pending await.
      Conclusion: after a successful model response, the product loop awaits something that
      never settles. Not a timeout, not the network, not compaction. `MUONROI_LOOP_PROFILE` is
      the wrong instrument for this class — fixing it needs instrumentation at the `await`
      sites, not an env flag.
- [x] **D3-3c** Side finding, also ours: **`tui_stop` returns `ok` without killing the child.**
      All 8 TUIs started this session were still running afterwards (verified by pid), leaking a
      bun process each time. Relevant to anyone driving the harness in a loop.
- [ ] **D3-4** Recovery: after a failing test run, does it converge or thrash?
- [ ] **D3-5** Instruction adherence over a long turn (does it drift from the stated goal?).

## D4 — Multi-agent / adversarial reasoning (council)

- [x] **D4-1** Council convenes and holds 3 rounds across 3 StepFun models.
      *Evidence:* 21+ calls billed `source=council`; research phase produced citations with
      real URLs; panel = Researcher / Cost-Controller / Skeptic / Architect + leader.
- [x] **D4-2** **Genuinely adversarial, not sycophantic.** The Skeptic flagged that
      `x-user-id` is client-controlled so the limiter is spoofable, and self-labelled
      `[CONFIRMED via README]` vs `[UNVERIFIED]`. On a separate task the Critical Reviewer
      caught the classic `if (!memo[n])` falsy bug for `fib(0) = 0`. **Works well — say so.**
- [x] **D4-3** *Failure mode:* plausible-but-language-wrong critique. The Architect argued
      "two concurrent requests can both see 59/60 and both burst to 120 req/min" — a real
      concern in a threaded runtime, but `checkRateLimit` is a synchronous function in
      single-threaded Node, so no such interleaving exists. Confident, well-argued, wrong for
      the language it was reviewing.
      *Ask for:* stronger runtime/concurrency-model grounding before raising race conditions.
- [ ] **D4-4** Does it hold a position under pressure, or capitulate to the loudest peer?

## D5 — Context, caching, cost

- [x] **D5-1** Prompt caching works. *Evidence:* `prompt_tokens_details.cached_tokens: 16`
      on a streaming call; cache-read tokens recorded per call.
- [x] **D5-2** Cost profile: 39 calls across a `/ideal` run = **$0.058**.
- [x] **D5-3** Latency: `step-3.7-flash` median **24.0 s/turn**, max 94 s, ~**28 tok/s** output
      (n=12 agent turns).
- [x] **D5-4** Prompt caching is prefix-stable and effective, with one wrinkle.
      Byte-identical requests x8: two cold calls, then **90.1% for 6/6**. Stable system prefix
      with a varying user tail x8 (the real agentic shape): **89.8% on 7/8**. Growing history
      x6: 90.0% decaying to 87.6% as the tail grows, as expected.
      Two observations worth sending: `cached_tokens` is always exactly **2560** — it looks
      quantised to a block rather than tracking the true shared prefix — and roughly **1 call in
      8 misses entirely** (full price) with no visible cause.
      *Ask for:* confirm the cache block size, and whether the intermittent full miss is
      eviction, sharding, or expected.
- [x] **D5-5** **The 256K window is real and usable, not nominal.** Needle-in-a-haystack over a
      synthetic engineering changelog, single fact planted at varying depth, `reasoning_effort: low`:
      | Input tokens | Needle depth | Latency | Retrieved |
      |---|---|---|---|
      | 38,321 | 10% | 8.0 s | yes |
      | 38,346 | 55% | 10.4 s | yes |
      | 38,357 | 92% | 17.0 s | yes |
      | 153,142 | 50% | 19.5 s | yes |
      | 153,201 | 95% | 44.6 s | yes |
      | **246,738** | 95% | 34.2 s | yes |
      6/6, including 96% of the advertised window, with no depth-dependent degradation.
      **Works well — say so, with the numbers.**
- [ ] **D5-6** Accuracy of `max_output_tokens` — the API accepted `max_tokens` up to 131072
      without rejecting, so the true ceiling is **not discoverable from the API**.
      *Ask for:* documented per-model max output, or a 400 when it is exceeded.

## D6 — Serving / API robustness

- [x] **D6-1** **Plan vs pay-as-you-go base URL is a silent trap.** With a Step-Plan-only key:
      `POST /v1/chat/completions` → **HTTP 402 `quota_exceeded`**, while `GET /v1/models` →
      **200**. The key looks valid, so the failure reads as a billing problem rather than a
      wrong-endpoint problem.
      *Ask for:* make `/v1` return an error that names `/step_plan/v1`, or let plan keys work
      on both.
- [x] **D6-2** Streaming: SSE deltas correct, `reasoning`/`reasoning_content` both present.
- [x] **D6-3** Vision on `step-3.7-flash` works (base64 `image_url` → correct answer).
- [x] **D6-4** No 429 observed at 4 parallel council participants, despite the documented
      10 req/min limit. *Open question for them:* what is the real enforced RPM on Step Pro?
- [ ] **D6-5** Deliberate 429: confirm `Retry-After` is returned and backoff guidance holds.
- [x] **D6-6** `response_format` works. `{"type":"json_object"}` → parseable JSON;
      `{"type":"json_schema", ...}` → object matching the schema. **Works well — say so.**
- [ ] **D6-7** Error-message quality sweep: are 4xx bodies caller-actionable? (D1-4 says no.)

## D7 — Localisation

- [x] **D7-1** Vietnamese is fluent and the concept explanation was correct.
      *But the worked example was wrong:* its closure counter used `dem++` (post-increment) and
      annotated the output `// 1` then `// 2`; actually running it prints `0` then `1`.
      Small, but it is teaching content — an off-by-one in an explainer is high-visibility.
- [x] **D7-2** Mixed-language instruction adherence is correct: English code comments +
      Vietnamese prose, exactly as the system prompt demanded, with a genuinely good
      `debounce` (leading-edge `immediate`, plus `cancel`/`flush`).
      *Caveat that reinforces D2-1:* at `max_tokens: 3072` this same request returned
      **0 characters of content after 9,233 characters of reasoning** (`finish_reason: "length"`).
      It needed `8192` to answer at all (11,964 reasoning + 5,957 content). A routine
      "write a function and explain it" request does not fit in budgets many frameworks
      default to.
- [ ] **D7-3** Longer mixed VI/EN sessions (multi-turn, with tools).

## D8 — Model comparison (informs "what you'd like to see next")

- [ ] **D8-1** `step-3.7-flash` vs `step-3.5-flash` on the same agentic task: quality vs
      latency vs cost.
- [ ] **D8-2** Is `step-3.5-flash-2603` meaningfully different from `step-3.5-flash`?
- [ ] **D8-3** Where does each sit against the models this CLI routes to today?

Out of scope: `stepaudio-*` and `step-image-edit-2` — not reachable from a coding CLI
(correctly marked non-routable in our catalog).

---

## The exchange — state it in every report

A probe only keeps running if it pays both ways, so each weekly report ends by saying so
plainly. Rule: **every value claim must point at a number already in that week's findings.**
An unbacked claim here costs more credibility than it buys.

**What StepFun gets**
- A test surface that is hard to build in-house: multi-turn tool loops, compaction that rewrites
  tool-call `arguments`, a multi-agent council, plan→implement→verify.
  **Tag every finding with how it was found, and report the split honestly.** Week 1 was
  **5 of 7 curl-testable** (they could have found those themselves; the value is only that
  someone did) and **2 of 7 not**: the `fromjson` crash needed ~100 KB of accumulated history
  before that code path opened at all, and the mis-calibrated critique needed one model
  reviewing another instance's code. Those two are what the probe is for.
  *A first draft of this section claimed "5 of 7 only appear under sustained load" — the exact
  inverse, and unchecked. Count the findings before writing the ratio.*
- Findings reproducible without our CLI — a minimal curl with exact status codes and counts.
- A reporter that separates their bugs from ours: week 1 logged 4 as ours and **withdrew** one
  finding after it failed to replicate 4/4.
- Positioning evidence a benchmark cannot produce: 246,738 input tokens with the needle found at
  95% depth; parallel tool calls in history accepted where two providers we route to reject them.
- Cost to them: ~$0.20 of inference for the week.

**What we get**
- A model that survives the harness (nested schema fidelity, a real 256K window, ~90% cache hit,
  a genuinely adversarial council reviewer).
- Economics that make agentic loops viable: $0.058 per 39-call product-loop run, 24 s median
  turn, ~28 tok/s.
- Their strictness finds our bugs — the `fromjson` 400 exposed a latent compactor defect that
  would have broken against any validating provider.
- A second opinion on our own pipeline: driving `/ideal` hard enough to test them localised a
  reproducible wedge on our side.

**The move that makes it a collaboration, not a report:** close each week by inviting them to
aim the harness — a tool-calling pattern, a long-context shape, a multi-agent scenario, or a
regression to watch across a model update. We run it weekly regardless; letting them pick the
target is what converts one-way feedback into a loop.

## Weekly report template

```
StepFun Builder feedback — muonroi-cli — week of <date>
Models: <ids>   Base: https://api.stepfun.ai/step_plan/v1   UID: 400878669599649792

WORKS WELL
- <item id> — <one line> — <measured evidence>

FALLS SHORT
- <item id> — <symptom> — <minimal repro> — <impact on agentic use>

WHAT WE'D LIKE NEXT
- <ask, tied to an item above>

NOT A STEPFUN BUG (logged for transparency)
- <ours, and what we changed>
```

Keeping the last section is deliberate: it is what makes the other three credible.


---

## Running list — NOT StepFun bugs (keep, for the report's credibility section)

1. **Compactor emitted non-object `tool_calls.arguments`** → surfaced as StepFun's
   `fromjson` 400. Ours. Fixed in `src/orchestrator/subagent-compactor.ts`
   (commit `e2d18229`, branch `fix/stepfun-elided-tool-args`). StepFun's half — an
   unregistered Jinja filter and an unhelpful error string — is still worth reporting (D1-4).
2. **`/ideal` wedges after scoping** with no pending request, no error, no watchdog. Ours.
   See D3-3. Matches the existing `council_reasoning_hang` note (orphaned inner generator).
3. **`stepfun` was in `disabledProviders`**, so `/council` reported "No reachable provider".
   Ours — local config, not an API failure.
4. **Step Plan base URL not configured** → HTTP 402. Ours to configure, but the confusing
   402-with-valid-key behaviour is theirs to improve (D6-1).
