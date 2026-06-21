# Maturity-Fixes — Real-CLI Verification Plan

> Verification is by driving the **real built CLI** — the MCP drive-harness (`mcp__muonroi-harness__tui_*`) or headless `bun run src/index.ts -p ...` — **not** vitest/python. Default model is **xAI grok-4.3** (OAuth). Scope: 16 commits promoted from `integration/maturity-fixes` → `master`. All cited commit SHAs confirmed present in `git log` (see §0.5).

---

## 0. Preconditions & shared setup

### 0.1 Build the dist FIRST (non-negotiable)
The running `muonroi-tools` MCP binary and the dev CLI may predate the merge. Per MEMORY `muonroi-tools MCP binary`, the compiled binary needs rebuild + rename-swap + `/mcp` reconnect; the `muonroi-harness` MCP runs TS source so only needs a reconnect.
```powershell
cd D:\sources\Core\muonroi-cli
bun run build           # produces dist/index.js carrying ee_write + the merged loop
```
- **Hard check before any MCP-tool scenario:** `mcp__muonroi-tools__*` must advertise **`ee_write`**. If `listTools` shows only `ee_query/ee_feedback/ee_health`, the running binary is stale — rebuild + reconnect before proceeding (this is the explicit blocker for `ee-write-advertised-over-stdio`).

### 0.2 Model & env
- `MUONROI_MODEL=grok-4.3` (xAI OAuth) for all live-LLM scenarios. xAI grok-4.3 has a **known mid-turn stall** flake → allow **one whole-run retry** per live scenario.
- **Cold boot is 25–46s** → use `tui_wait_for { idle:true, timeoutMs: 60000 }` minimum; live debate/multi-turn runs need 90–180s.
- **Greenfield temp cwd** for any council/`/ideal`/multi-step run (repo-root discover scan is slow + races timeouts). Pre-`git init` it when the scenario asserts git state.
- **Force EE-down for classifier determinism** on council routing scenarios (CLAUDE.md caveat). EE-up is only required where a scenario explicitly writes/recalls to the brain.
- Deterministic (no-token) scenarios use `--mock-llm <dir>` with a dummy `-k FAKE_KEY_FOR_TESTS` + `MUONROI_TEST_NO_KEYCHAIN=1`. Mock-llm path **must resolve inside repo root** (`validateMockLlmPath`).
- For auto-commit / git_commit positive cases the child **must NOT** have `VITEST` or `NODE_ENV=test` set (both disable the commit paths, `auto-commit.ts:55-57`). The MCP harness strips `NODE_OPTIONS`/`LD_*` but not these — verify they're unset.

### 0.3 EE reachability check (gate, not failure)
```
mcp__muonroi-tools__ee_health   →  expect { ok:true }
```
If EE is down, EE-write/recall scenarios are **SKIP (precondition unmet), not FAIL**. Confirmed reachable this session (`exp-recall.js` returned live hits; backend `https://experience.muonroi.com`).

### 0.4 Harness tools you may use (do not invent others)
`tui_start, tui_stop, tui_type, tui_press, tui_press_sequence, tui_wait_for, tui_query, tui_query_all, tui_count, tui_expect, tui_snapshot, tui_render_text, tui_last_event, tui_changes_since, tui_capabilities, tui_focus`; EE: `ee_query, ee_feedback, ee_health, usage_forensics`. **There is NO LiveEvent for ee_write / git_commit / auto-commit** — assert via git log, content-chunk text, tool-result strings, or interaction-log rows.

### 0.5 Git-log commit assertions (run once; pure, free)
```
git log --oneline | <find>:
  18d0373 feat(harness): opt-in extra cwd roots …
  2462830 fix(orchestrator): surface actionable status for opaque 5xx …
  efa8485 fix(orchestrator): retry transient error-parts (no-content) …
  f7774b7 fix(orchestrator): resume transient error-parts AFTER a tool step
  8073e62 / aab28c7 feat(ee): close … recall feedback loop …
  9003414 fix(ee): make the unified PIL path reachable (raise call budget)
  cae0895 feat(ee): add ee_write …            875ddb5 mirror ee_write into MCP
  871aefd perf(council): cap debate-turn verbosity …
  111db48 feat(orchestrator): auto-commit … at turn end
  25ead7c feat(commit): agent writes its own commit messages via git_commit
```
All 16 confirmed present on HEAD. `git show 871aefd --stat` confirmed: **1 file, `src/council/prompts.ts`, +25 −0**.

---

## 1. Execution order (P0-first; broken core fails fast)

Run **cheap deterministic gates first**, then deterministic-mock CLI runs, then live-LLM. Stop the gate if a P0 in a tier fails.

| # | Scenario ID | Why first | Cost |
|---|---|---|---|
| 1 | `council-conciseness-static-grounding` | Pure git/grep + council vitest; catches re-added routing substrings / lowered maxTokens at zero cost | free |
| 2 | `unified-budget-default-3500` | Pure-fn reachability gate; proves unified PIL isn't a dead no-op | free |
| 3 | `err-5xx-forensics-headless` | Direct `error-utils` assertion; the only deterministic proof of 5xx canned text + redacted forensics | free |
| 4 | `ee-write-advertised-over-stdio` | stdio `listTools` must show `ee_write` — if absent the whole MCP-mirror feature is invisible; also confirms dist rebuilt | ~5s |
| 5 | `autocommit-backstop-headless-positive` | Mock-llm; headline auto-commit promise, fully deterministic | mock |
| 6 | `autocommit-respects-dirtybefore-and-exclusions` | Mock-llm; secret-leak / WIP-sweep is the most dangerous failure | mock |
| 7 | `err-part-transient-retry-event` | Mock-llm nested stream; proves no-content error-part retry | mock |
| 8 | `err-part-resume-after-tool-step` | Mock-llm; highest-value "fail liên tục" fix | mock |
| 9 | `extra-root-allows-sibling-repo-cwd` | Live harness start gate; dogfood enabler | ~1m |
| 10 | `clean-deny-outside-all-roots` | Security: default-deny must hold with extras present | ~5s |
| 11 | `ee-write-roundtrip-recall` | Live EE; ee_write headline round-trip | live+EE |
| 12 | `ee-write-roundtrip-real-ee` | Live EE via MCP mirror | live+EE |
| 13 | `git-commit-agent-message-attribution` | Live grok; agent-authored commit message | live |
| 14 | `council-debate-turn-wordcap-headless` | Live grok council; word-cap behavior | live |
| 15+ | all P1/P2 (see §2) | after P0 green | mixed |

---

## 2. Per-feature test scenarios

> Acceptance items are **binary**. `SKIP` (precondition unmet, e.g. EE down) is distinct from `FAIL`. Real-LLM word/behavior assertions use **generous thresholds**, never exact equality.

### Feature A — EE recall feedback loop on the unified PIL path

#### A1 · `unified-budget-default-3500` — P0
- **Goal:** Prove `getUnifiedPilBudgetMs()` = 3500 unset, env-overridable, clamped [1000,8000]; `isUnifiedPilEnabled()` gated on `MUONROI_PIL_UNIFIED=1`.
- **Why:** Commit `9003414` — the old 1500ms budget aborted before the classifier-bound server answered, making `MUONROI_PIL_UNIFIED=1` a permanent no-op. Verified: `config.ts:7-11` (flag, default OFF), `config.ts:22-26` (budget). Pure-fn gate; no EE/network.
- **Harness setup:** Headless, repo root, no model. `bun -e` importing `./src/pil/config.ts` (bun TS loader).
- **Steps:**
  1. `bun -e "import('./src/pil/config.ts').then(m=>console.log('default='+m.getUnifiedPilBudgetMs()))"` (clean env)
  2. `MUONROI_PIL_UNIFIED_BUDGET_MS=6000 bun -e "...getUnifiedPilBudgetMs()"`
  3. `=100` and `=99999` variants
  4. Assert `isUnifiedPilEnabled()` false unset / true at `=1`
- **Expected:** `3500 / 6000 / 1000 / 8000`; flag false→true.
- **Acceptance:** ☐ `default=3500` ☐ `set=6000` ☐ low-clamp prints `1000` ☐ high-clamp prints `8000` ☐ flag false unset, true at `=1`
- **Risks:** None (deterministic). `bun -e` of `.ts` must run from repo root.

#### A2 · `ee-injection-row-unified-source` — P0
- **Goal:** With `MUONROI_PIL_UNIFIED=1` + thin EE client + substantive coding prompt, find an `interaction_logs` `ee_injection` row with `data.source='unified'`, numeric `ledgerRecorded`/`ledgerPending`, non-empty `pointIds[]`.
- **Why:** Only deterministic machine-readable proof the unified path **fired AND recorded recall debt**. `source:'unified'` (layer3-ee-injection.ts:307) appears only on the unified branch; `ledgerRecorded>0` proves the new rateable-ledger wiring; `pointIds` proves id-bearing points (schema 1.1+).
- **Harness setup:** Headless `-p`. **Requires** thin-client EE (`~/.experience/config.json` `serverBaseUrl`+auth) returning id-bearing points. `MUONROI_PIL_UNIFIED=1 MUONROI_PIL_UNIFIED_BUDGET_MS=4000 EXPERIENCE_RECALL_FEEDBACK_GATE=soft MUONROI_MODEL=grok-4.3 bun run src/index.ts -p 'refactor the auth token cache to use an LRU and add expiry' -m grok-4.3 --format text`. cwd=repo root.
- **Steps:** ① `ee_health` (down→SKIP) ② run cmd, complete one turn ③ resolve newest session_id ④ query `interaction_logs WHERE event_type='ee_injection'` (or `getInteractionLogsForRun`) ⑤ parse `metadata_json.data`.
- **Expected:** ≥1 row, `data.source='unified'`, `ledgerRecorded>=1`, `ledgerPending>=ledgerRecorded`, `pointIds` non-empty.
- **Acceptance:** ☐ row exists with `data.source==='unified'` ☐ `ledgerRecorded` integer ≥1 ☐ `pointIds.length === ledgerRecorded` ☐ `ledgerPending >= ledgerRecorded`
- **Risks:** Needs id-bearing server (schema 1.1+); empty `pointIds`/`ledgerRecorded=0` on an older server = **SKIP** (check via pre-flight `ee_query` for `[id col]` handles). If the unified call times out, row shows legacy shape (no `source`) → **FAIL correctly** (reachability regression). Cold EE on turn-1 can route legacy → pre-warm with one `ee_query` and retry once. **Note:** the flag is default-OFF and `pilContext` returns null for fat EE clients — unified only fires with `MUONROI_PIL_UNIFIED=1` AND thin-client config.

#### A3 · `injected-id-marker-and-nudge-in-prompt` — P1
- **Goal:** Confirm injected experience lines carry `[id:..]` markers + the feedback nudge in the **enriched system-prompt string** (not a chunk/LiveEvent).
- **Why:** Markers live at `layer3-ee-injection.ts:246-247` (unified `renderLine`), nudge `RECALL_FEEDBACK_NUDGE` (`:65-66`), pending reminder (`recall-ledger.ts:95-105`). The `experience_injected` StreamChunk routes to `_activeEeYield` (TUI-only, no UI renderer, no LiveEvent) — **not harness-observable**; the prompt text is.
- **Harness setup:** Headless `-p`, `MUONROI_PIL_UNIFIED=1 EXPERIENCE_RECALL_FEEDBACK_GATE=soft MUONROI_DEBUG_LLM_WIRE=1 MUONROI_MODEL=grok-4.3 bun run src/index.ts -p '<topic matching stored lesson, e.g. wrap the external API call in try/catch and log the error>' -m grok-4.3 --format text 2>wire.log`.
- **Steps:** ① pre-flight `ee_query '<topic>'` confirms `[id col]` hits (else SKIP) ② run capturing stderr ③ grep `wire.log` for `/\[id:[^\]]+\]/` inside a `[principles:|[experience:|[rules:` block ④ grep for `Rate it: ee_feedback` OR `still unrated` ⑤ secondary: model issues an `ee_feedback` referencing a surfaced id.
- **Expected:** Injected block with `[id:..]` handle followed by nudge/pending-reminder text.
- **Acceptance:** ☐ `wire.log` has `/\[(principles|experience|rules):/` + an `[id:..]` token on a following bullet ☐ contains `ee_feedback` AND (`Rate it` OR `still unrated`) ☐ marker id matches a pre-flight `ee_query` id
- **Risks:** Depends on `MUONROI_DEBUG_LLM_WIRE` dumping the full system prompt; if it doesn't, fall back to A2's DB row + observing the model's `ee_feedback` call. No topic match → **SKIP**.

#### A4 · `ee-feedback-clears-ledger-same-process` — P1
- **Goal:** After injection records N pending entries, an in-process `ee_feedback(id, collection, followed)` removes that id from the ledger on the next turn's logged `ledgerPending` — **same process**.
- **Why:** Closes the loop. Native `ee_feedback` clears `sessionRecallLedger` (`native-tools.ts:104-105`). The ledger is **module-scoped per process**: CLI PIL injection + native `ee_feedback` share it; the **external `muonroi-tools` MCP `ee_feedback` is a DIFFERENT process and will NOT clear the CLI ledger** (negative control).
- **Harness setup:** Single CLI process, two turns. `tui_start args=['--agent-mode'] env={MUONROI_PIL_UNIFIED:'1', EXPERIENCE_RECALL_FEEDBACK_GATE:'soft', MUONROI_MODEL:'grok-4.3'}`. cwd=repo root.
- **Steps:** ① start; `wait_for idle` (60s) ② pre-flight `ee_query` (else SKIP) ③ Turn 1 topic prompt → idle → read newest `ee_injection` row `P1`(≥1) + first `pointId`+collection ④ in-process native `ee_feedback(pointId, collection, followed)` → `ok:true` ⑤ Turn 2 topic prompt → idle → read newest `ee_injection` row `P2` ⑥ assert the fed-back id is **absent** from turn-2 pending (not merely `P2<P1`) ⑦ stop.
- **Expected:** Fed-back id gone from pending; new debt may appear; `ee_feedback` POST `ok:true`.
- **Acceptance:** ☐ turn-1 `ledgerPending P1>=1` + captured pointId ☐ native `ee_feedback(...,followed)` returns `ok:true` ☐ turn-2 pending set excludes the fed-back pointId ☐ verdict reached brain (`ok:true`)
- **Risks:** Feedback **must** be the in-process native builtin, NOT external MCP. Two grok turns = cost/time + stall risk → keep prompts short. EE write endpoint down → **SKIP**.

---

### Feature B — `ee_write` native tool (in-CLI agent)

#### B1 · `ee-write-roundtrip-recall` — P0
- **Goal:** Agent writes a unique sentinel lesson via `ee_write`; it's recallable seconds later via `ee_query` in one live session.
- **Why:** Headline claim. Endpoints verified live (import-memory `stored:1/ok:true` → recall `count` with marker). `ee_write` success returns literal `{"ok":true,"id":"<uuid>","collection":"experience-behavioral","recallable":"now — same session via ee_query"}` (`native-tools.ts:169`). **No LiveEvent** — assert on tool-result content.
- **Harness setup:** `tui_start args=['--agent-mode'] cwd=<greenfield temp> env={MUONROI_MODEL:'grok-4.3', EXP_SESSION:'ee-write-p0-<ts>'}`. EE reachable. Sentinel `ZQX7LESSONPROBE<ts>`.
- **Steps:** ① start; `wait_for idle 60000` ② type: *"Use the ee_write tool RIGHT NOW to save verbatim, collection experience-behavioral: \"ZQX7LESSONPROBE<ts>: when wiring a named-pipe transport on Windows, never pass stdio pipe fds — use \\\\.\\pipe paths.\" Report the JSON the tool returns."* ③ Enter; `wait_for idle 90000` ④ `tui_render_text` → assert success JSON ⑤ type: *"Call ee_query with query exactly ZQX7LESSONPROBE<ts> and report whether the lesson comes back."* → Enter → idle ⑥ `tui_render_text` ⑦ independently `mcp__muonroi-tools__ee_query { query:'ZQX7LESSONPROBE<ts>' }`.
- **Expected:** `ee_write` JSON `ok:true`+uuid; subsequent `ee_query` (in-CLI and/or MCP) text contains the sentinel.
- **Acceptance:** ☐ write-turn `render_text` contains `"ok":true` AND `recallable` ☐ recall-turn `render_text` OR MCP `ee_query` contains exact `ZQX7LESSONPROBE<ts>` ☐ no `ERROR write_failed` / `ee_unavailable` in either turn ☐ allow one `ee_query` retry after 3s (indexing lag ~2-3s)
- **Risks:** Cold boot → 60s+ idle waits. Sentinel **must** be unique nonsense (generic tokens get buried — proven live). Do not assert a LiveEvent (none exists). grok may not auto-fire → imperative prompt.

#### B2 · `ee-write-validation-shortlesson` — P0
- **Goal:** A `<12`-char lesson returns `invalid_args` with **no network call**.
- **Why:** Data-quality guard (`native-tools.ts:145-148`). Deterministic — guard fires before POST. Dropping the guard pollutes the brain with stubs.
- **Harness setup:** Headless, greenfield cwd, EE-irrelevant. `bun run src/index.ts -p 'Call the ee_write tool with exactly lesson="oops" and nothing else. Report the tool result verbatim.' -m grok-4.3 --format text`.
- **Steps:** run → capture stdout → assert rejection.
- **Acceptance:** ☐ stdout contains `invalid_args` ☐ stdout does NOT contain `"ok":true` ☐ stdout does NOT contain `write_failed` (short-circuited pre-network)
- **Risks:** Model may paraphrase — assert on the stable `invalid_args` token, not the full sentence.

#### B3 · `ee-write-eedown-graceful` — P1
- **Goal:** With EE unreachable, `ee_write` returns logged `ERROR write_failed`, turn continues, no crash (No-Silent-Catch).
- **Why:** `search.ts:331-335` `logEeFailure` + return `{ok:false}`. A throw would abort the turn whenever EE is flaky.
- **Harness setup:** No `MUONROI_EE_DISABLED` flag exists → force unreachable: run headless with `HOME`/`USERPROFILE` pointed at an empty temp dir (no `~/.experience/config.json` → fallback `localhost:8082` with nothing listening). `bun run src/index.ts -p 'Call ee_write with lesson="NEGCASE<ts>: always free the named-pipe handle on TUI exit." then report the exact tool result.' -m grok-4.3 --format text`.
- **Steps:** ensure no listener on resolved base → run → capture stdout + exit code → assert graceful.
- **Acceptance:** ☐ stdout contains `write_failed` ☐ no `"ok":true` ☐ process exits cleanly (no unhandled-rejection stack in stderr) ☐ later `ee_query NEGCASE<ts>` returns no hit
- **Risks:** Overriding HOME for a bun child is fiddly on Windows → downgrade to P2/manual if infeasible. Must guarantee `localhost:8082` is actually down (a running local EE → false pass).

#### B4 · `ee-write-collection-and-scope` — P2
- **Goal:** `collection="experience-principles"` routes correctly; lesson scoped to `path.basename(cwd)`.
- **Why:** Second enum branch + project-scoping (`native-tools.ts:152-153,165`). Lower priority — P0 covers the default collection.
- **Harness setup:** `tui_start cwd=<greenfield temp with basename `eewrite-principles-probe`> env MUONROI_MODEL=grok-4.3`. Sentinel `PRINCIPLEPROBE<ts>`.
- **Steps:** start→idle→ type: *"Call ee_write with collection=experience-principles and lesson=\"PRINCIPLEPROBE<ts>: prefer dense+sparse import-memory over dense-only ingest for recall-critical writes.\" Report the JSON."* → Enter → idle → `render_text` → independent `ee_query PRINCIPLEPROBE<ts>`.
- **Acceptance:** ☐ `render_text` contains `"collection":"experience-principles"` ☐ `ee_query` returns sentinel with `[id ... col:experience-principles]` handle ☐ no `write_failed`/`ee_unavailable`
- **Risks:** Recall handle may abbreviate `col` → loose substring match. Writing to principles pollutes a shared tier → throwaway sentinel; prune after. Indexing lag → retry once.

---

### Feature C — `ee_write` mirrored into `muonroi-tools` MCP

#### C1 · `ee-write-advertised-over-stdio` — P0
- **Goal:** The freshly-built tools-mcp server advertises `ee_write` (with correct inputSchema) over stdio.
- **Why:** Core promise — external agents must SEE it. Existing smoke test (`tools-server.smoke.test.ts:32-36`) asserts `ee_query/feedback/health` but **NOT** `ee_write` — uncovered guarantee. Live MCP this session lacks `ee_write` (stale binary).
- **Harness setup:** `bun run build` then stdio MCP client to `node dist/index.js tools-mcp` (or `bun run src/index.ts tools-mcp`). cwd=repo root. No EE needed for `listTools`.
- **Steps:** initialize → `listTools()` → assert names include `ee_write` + the three siblings → read `ee_write.inputSchema`.
- **Acceptance:** ☐ `listTools().tools.map(t=>t.name)` includes `ee_write` ☐ schema marks `lesson` required (min 12) ☐ `collection` enum is exactly `[experience-behavioral, experience-principles]` ☐ `ee_query/ee_feedback/ee_health` still present (no sibling regression)
- **Risks:** **MUST rebuild dist** (the live session binary lacks `ee_write`). Prefer `node dist/index.js` (stdio handshake stabler than bun on Windows). Cold `loadCatalog` adds a few seconds.

#### C2 · `ee-write-roundtrip-real-ee` — P0
- **Goal:** External `ee_write` persists a sentinel via `/api/import-memory`; `ee_query` retrieves it.
- **Why:** Backend contract — same `writeExperienceEE` helper as native (`ee-tools.ts:231` / `native-tools.ts:157,162`). Proves the mirror is functional, not just advertised.
- **Harness setup:** Rebuilt dist + reconnected MCP. `ee_health` `{ok:true}` (else SKIP). High-entropy sentinel `ee-write-mirror-probe-<uuid>`.
- **Steps:** ① `ee_health` (down→SKIP) ② `mcp__muonroi-tools__ee_write { lesson:'<S>: call flushFrob() before reindex or reads go stale', title:'reindex pitfall', collection:'experience-behavioral', project:'muonroi-cli' }` ③ assert result JSON ④ `mcp__muonroi-tools__ee_query { query:'<S>' }` ⑤ assert recall text contains S + `[id col]`.
- **Acceptance:** ☐ result parses to `{ok:true, id:<truthy>, collection:'experience-behavioral', recallable:'now via ee_query'}` ☐ `isError` falsy ☐ `ee_query` text contains S ☐ contains an `[id col]` handle
- **Risks:** Needs live EE + write auth → down/read-only = **SKIP**. Index lag → retry `ee_query` once. **Writes to shared brain** → keep sentinel unique; no generic lessons.

#### C3 · `ee-write-failure-and-validation` — P1
- **Goal:** (a) backend/EE-down → structured `{error:'write_failed'}` `isError:true` (No-Silent-Catch); (b) `<12`-char lesson rejected by zod before any network call.
- **Why:** `ee-tools.ts:239,242` map both `{ok:false}` and thrown errors to `write_failed`; min-12 floor at `ee-tools.ts:220-225`. Guards a fake-success regression.
- **Harness setup:** Build dist; stdio client to `node dist/index.js tools-mcp`. (a) point EE base at a dead host (`127.0.0.1:1`) for the run, then restore — **do not** leave the shared production EE stopped. (b) call with a 5-char lesson.
- **Steps:** A: EE unreachable → `ee_write` valid ≥12-char lesson → assert `isError:true` + `error:'write_failed'` + non-empty message. B: `ee_write lesson='short'` → assert schema rejection / no `ok:true` and no `/api/import-memory` POST.
- **Acceptance:** ☐ A: `isError===true`, `error==='write_failed'`, non-empty message ☐ A: message propagated from `writeExperienceEE` (not swallowed null) ☐ B: 5-char lesson rejected, no `ok:true`, no import-memory request
- **Risks:** EE-down deterministically: simplest is `serverBaseUrl→127.0.0.1:1` for the duration. If SDK forwards despite zod, assert at minimum the 5-char lesson does NOT return `ok:true`. Never leave shared EE stopped.

#### C4 · `ee-write-mcp-vs-native-parity` — P2
- **Goal:** MCP and native `ee_write` share the backend path; document the two intentional divergences (project scope source + recallable string).
- **Why:** Both call `writeExperienceEE` but NOT byte-identical: MCP scopes by the `project` ARG (`ee-tools.ts:236`), native by `path.basename(cwd)` (`native-tools.ts:165`); success strings differ (`'now via ee_query'` vs `'now — same session via ee_query'`). Pins the divergence so it isn't mistaken for a bug.
- **Harness setup:** Greenfield temp dir `T`; EE up. MCP arm: `ee_write project=basename(T)`. Native arm: `bun run src/index.ts -p "You just learned: <S2-native>. Record it with ee_write." -m grok-4.3` from inside T.
- **Steps:** mkdir T → `ee_health` → MCP `ee_write lesson=S2 project=basename(T)` → native arm → `ee_query` both → optionally inspect stored `scope.project_slug`.
- **Acceptance:** ☐ MCP returns `recallable:'now via ee_query'` ☐ native returns `recallable:'now — same session via ee_query'` ☐ both S2 & S2-native recallable ☐ both carry `tier:2`/`confidence:0.65`/`runtime:'muonroi-cli-agent'`
- **Risks:** Native arm depends on grok deciding to call `ee_write` — no-call run = **INCONCLUSIVE** not FAIL. Scope inspection needs brain payload read (`qdrant-find`) — if unavailable, assert only the recallable-string divergence. Needs live EE.

---

### Feature D — Council debate token-thrift

#### D1 · `council-conciseness-static-grounding` — P0
- **Goal:** `concisenessRule` exists, injected at opening/response/followup with **220/160/140**; commit is single-file +25; maxTokens NOT lowered; rule text avoids the 4 mock-routing substrings; council vitest green.
- **Why:** Two HARD deterministic promises of `871aefd`: rule wired into all 3 turn types, and it cannot break prompt-routing mocks. Zero-token, zero-flake.
- **Harness setup:** No TUI; repo root; built dist; git/grep + targeted vitest.
- **Steps:** ① `git show 871aefd --stat` → 1 file `src/council/prompts.ts` +25 ② find `concisenessRule(` in `prompts.ts` → exactly 3 sites args `220,160,140` (lines 258/290/329) ③ confirm builders invoked at `debate.ts:404` (opening), `581/612` (response), `647/680` (followup) ④ rule body (`prompts.ts:214-221`) contains NONE of `'responding to' | 'continuing a discussion' | 'team lead' | 'Summarize this discussion'` ⑤ maxTokens in `llm.ts` debate-turn paths (473/522/549/639/676/730) all in `{4096,6144}`, none lowered ⑥ `bunx vitest run src/council/` → 0 failed.
- **Acceptance:** ☐ `git show 871aefd --stat` = exactly 1 file, `src/council/prompts.ts`, +25 −0 ☐ `concisenessRule` called with 220, 160, 140 — exactly 3 occurrences ☐ rule string contains `density over length` + `token-thrifty` and NONE of the 4 routing substrings ☐ no `maxTokens` literal in `llm.ts` debate paths below 4096 ☐ `bunx vitest run src/council/` exits 0, 0 failed
- **Risks:** None. (Verified now: `git show 871aefd --stat` = 1 file `src/council/prompts.ts` +25 −0.)
- *Note:* This is the **one** vitest invocation in the plan — it is a static routing-safety guard, not a behavioral verification.

#### D2 · `council-debate-turn-wordcap-headless` — P0
- **Goal:** Real debate turns obey the conciseness instruction (opening well under 220 words) with `llm-done.finishReason='stop'` (never `'length'`) — saving from writing less, not truncation.
- **Why:** Core behavioral promise. Regression = turns balloon to 400-600 words, or the cap causes `'length'` finishes.
- **Harness setup:** Headless, **greenfield temp cwd** (git init), `MUONROI_MODEL=grok-4.3 MUONROI_HARNESS_EVENTS=lifecycle`, EE forced-down. `bun run src/index.ts -p "Build a tiny in-memory rate limiter for an HTTP API" -m grok-4.3 --force-council --format text`.
- **Steps:** spawn `--force-council` in greenfield → collect `council_message` chunks `kind==='debate'` → wait `council-step phaseKind='opening' state='done'` before reading opening turns → word count `text.trim().split(/\s+/).length` → collect `llm-done.finishReason` for debate-turn correlationIds.
- **Acceptance:** ☐ ≥2 `council_message` debate turns captured ☐ median opening-turn word count ≤220, NO opening turn >330 (1.5× tolerance) ☐ every debate turn `llm-done.finishReason==='stop'` (zero `'length'`) ☐ no debate turn empty or starting `[Error:`
- **Risks:** Real-LLM variance → median + 1.5× ceiling, never exact. Cold boot + full debate 60-150s → wait on `council-step` events not sleeps. grok stall → one whole-run retry. Must be greenfield cwd. EE-down for routing determinism.

#### D3 · `council-routing-substrings-still-route` — P1
- **Goal:** The new text doesn't perturb live council routing — `/council` still reaches debate phases and emits lifecycle events.
- **Why:** Static grep (D1) proves substrings absent today; this proves the LIVE route still functions (catches indirect breakage, e.g. added block shifting a classifier threshold).
- **Harness setup:** MCP harness, greenfield cwd, `MUONROI_MODEL=grok-4.3`, EE forced-down. `/council Build a small URL shortener`.
- **Steps:** start→idle → type `/council Build a small URL shortener` → Enter → poll `council-step` via `tui_last_event`/`tui_wait_for` → wait `phaseKind='opening' active→done` → confirm a `council-speaker status='done'` → `render_text`/`snapshot` confirms debate cards.
- **Acceptance:** ☐ `council-step phaseKind==='opening' state==='done'` observed within timeout ☐ ≥1 `council-speaker status==='done'` ☐ ≥1 `council_message` (kind 'debate') visible ☐ no `toast level==='error'` referencing routing/classification
- **Risks:** Slow (60s+) → events not sleeps; greenfield cwd mandatory; grok stall → one retry; EE up → classifier nondeterminism → force EE-down.

#### D4 · `council-no-empty-turn-regression` — P1
- **Goal:** The cap does not starve turns — no empty/`[Error:`/truncated debate turns across opening+response+followup.
- **Why:** Quality floor — distinguishes "fewer words" (good) from "starved/truncated" (regression).
- **Harness setup:** Same as D2 but a 2-round-warranting prompt: `"Design a caching layer: in-memory vs Redis tradeoffs"`, `--force-council`, EE-down.
- **Steps:** run debate to ≥round 1 → capture every `council_message` `text`+`failureReason` → assert non-empty/no `[Error:` → cross-check `llm-done.finishReason!=='length'`.
- **Acceptance:** ☐ zero debate turns starting `[Error:` or with non-null `failureReason` ☐ zero turns word count <15 ☐ every debate-turn `finishReason==='stop'` ☐ ≥1 response or followup turn captured (progressed past opening)
- **Risks:** Variance → <15-word floor is generous. Needs round 1+ (90-180s) → wait `phaseKind='followup' state='done'`. Same greenfield/grok caveats.

---

### Feature E — Deterministic auto-commit backstop at turn end

> All auto-commit/git_commit positive cases: child must NOT have `VITEST`/`NODE_ENV=test`; `MUONROI_AUTO_COMMIT` unset (not 0). Temp repo cwd must be OUTSIDE the muonroi-cli working tree.

#### E1 · `autocommit-backstop-headless-positive` — P0
- **Goal:** Agent writes a file, does NOT call `git_commit`; turn-end backstop commits exactly that file with `Coding by - Muonroi-CLI`, emits `✓ Auto-committed`.
- **Why:** Headline of `111db48` — "task done → commit" survives the agent forgetting. Regression = work silently never lands in git.
- **Harness setup:** Headless + mock-llm (deterministic). Greenfield temp git repo (`git init`, `config user.*`, one initial commit → HEAD0). Mock fixture under repo: `{"model":{"provider":"deepseek","modelId":"deepseek-v4-flash","stream":[<toolCallStream write_file foo.txt>, <textOnlyStream 'done'>]}}`. `bun run <repo>/src/index.ts -p "create foo.txt" -m deepseek-v4-flash -k FAKE --mock-llm <repo>/tests/harness/fixtures/llm/<dir> --format text`, cwd=temp repo, `MUONROI_TEST_NO_KEYCHAIN=1`, VITEST/`MUONROI_AUTO_COMMIT` unset.
- **Steps:** setup repo + HEAD0 → author 2-round fixture (tool-call write_file, then text) → run → capture stdout → `git log -1 --pretty=%H%n%s%n%b` + `git show --name-only --pretty=format: HEAD`.
- **Acceptance:** ☐ stdout matches `/✓ Auto-committed 1 file\(s\) →/` ☐ stdout contains literal `(Coding by - Muonroi-CLI)` ☐ HEAD != HEAD0 ☐ `%s` starts `chore: update 1 file(s) — foo.txt` ☐ `%b` has a line equal `Coding by - Muonroi-CLI` ☐ `show --name-only` trimmed == exactly `foo.txt`
- **Risks:** Fixture must produce TWO doStream rounds or the loop never reaches the backstop. New file foo.txt needs no read-before-write. Temp cwd must not be inside muonroi-cli's tree.

#### E2 · `autocommit-respects-dirtybefore-and-exclusions` — P0
- **Goal:** (a) a file dirty BEFORE the turn is never folded in; (b) a secret/artifact (`.env`/`.muonroi-*`) the agent touches is never staged.
- **Why:** Safety contract = commit only `dirtyAfter − dirtyBefore` minus secrets/artifacts. WIP-sweep / `.env`-leak is the most dangerous failure mode.
- **Harness setup:** Same shape as E1. Before run: create uncommitted `user_wip.txt` (not `git add`). Fixture: round1 write_file `agent.txt`; round2 write_file `.env` content `SECRET=1`; round3 text `done`.
- **Steps:** init repo + initial commit + `user_wip.txt` → run → `git show --name-only --pretty=format: HEAD` + `git status --porcelain`.
- **Acceptance:** ☐ `show --name-only` trimmed non-empty lines == exactly `['agent.txt']` ☐ `status --porcelain` still lists `user_wip.txt` ☐ `status --porcelain` still lists `.env` (never staged — SENSITIVE_RE) ☐ stdout matches `/✓ Auto-committed 1 file\(s\)/` (count=1, not 2/3) ☐ HEAD body has `Coding by - Muonroi-CLI`
- **Risks:** `.env` exercises SENSITIVE_RE (highest severity); `.muonroi-*`/`*.log` exercise ARTIFACT_RE — either valid. `user_wip.txt` must have content + never be staged.

#### E3 · `autocommit-disabled-via-env` — P1
- **Goal:** `MUONROI_AUTO_COMMIT=0` → no auto-commit, no `✓` chunk, HEAD unchanged.
- **Why:** Kill-switch contract (`auto-commit.ts:53`). Ignoring it commits against user wishes.
- **Harness setup:** Identical to E1 + env `MUONROI_AUTO_COMMIT=0` (VITEST unset so the disable is attributable to the flag).
- **Steps:** init repo+HEAD0 → reuse E1 fixture → run with `MUONROI_AUTO_COMMIT=0` → stdout + `git rev-parse HEAD` + `git status --porcelain`.
- **Acceptance:** ☐ stdout does NOT match `/✓ Auto-committed/` ☐ HEAD == HEAD0 ☐ `status --porcelain` lists foo.txt (untracked, uncommitted)
- **Risks:** Low. write_file still runs → foo.txt exists on disk; assert uncommitted, not absent.

#### E4 · `autocommit-noop-when-agent-committed` — P1
- **Goal:** Agent writes a file AND calls `git_commit` itself → backstop adds NO second commit (`newPaths` empty → reason `no-agent-changes`).
- **Why:** Snapshot-diff dedup — without it every agent commit gets shadowed by a redundant `chore:` commit. *(See also cross-feature smoke X1.)*
- **Harness setup:** MCP harness or headless mock-llm. Greenfield temp git repo (under allowed root). Fixture: round1 write_file `bar.txt`; round2 git_commit `{message:'feat: add bar'}`; round3 text `done`. `MUONROI_TEST_NO_KEYCHAIN=1`, VITEST unset.
- **Steps:** `tui_start({cwd:tempRepo, mockLlmDir})` → idle → type `create bar.txt and commit it` → Enter → idle → `git log --pretty=%s%n%b` count since initial.
- **Acceptance:** ☐ `git log <initial>..HEAD --pretty=%s` = exactly ONE line, starts `feat: add bar` ☐ no commit subject starts `chore: update` ☐ TUI log does NOT contain `✓ Auto-committed` ☐ HEAD body has `Coding by - Muonroi-CLI` (from agent git_commit)
- **Risks:** Cold boot 25-46s → 60s+ waits. api-key modal focus grab → pass `MUONROI_TEST_NO_KEYCHAIN=1` or fall back to headless. `git_commit` stages `FileTracker.writtenPaths()` → bar.txt must be written via write_file in the SAME session. Verify round2 git_commit input matches the zod schema (message required, non-empty).

---

### Feature F — Agent-authored commits via `git_commit` tool

> Same env hygiene as Feature E (no VITEST/test, `MUONROI_AUTO_COMMIT` unset). **No git_commit LiveEvent** — assert via git log + tool-result string + content chunk.

#### F1 · `git-commit-agent-message-attribution` — P0
- **Goal:** Agent commits with a model-authored conventional subject (not a truncated prompt), only files it wrote staged, message ends with exactly one `Coding by - Muonroi-CLI` via separate `-m` flags (Windows-safe).
- **Why:** Headline of `25ead7c`. Guards: (a) attribution gluing onto subject (the Windows execFile `\n\n` mangling this fixed), (b) staging the whole tree, (c) raw prompt as subject.
- **Harness setup:** Headless built dist. `tmp=mktemp -d; git -C "$tmp" init; config user.*`. Seed `echo dirty > "$tmp/user-wip.txt"` (untracked). `cd "$tmp" && MUONROI_MODEL=grok-4.3 bun run <repo>/src/index.ts -p "Create a file hello.ts that exports greet() returning 'hi', then commit it with git_commit using a clear conventional message." -m grok-4.3 --format text`. xAI OAuth active.
- **Steps:** temp repo + user-wip.txt → run from inside `$tmp` → wait process exit → assert git log + tree.
- **Acceptance:** ☐ `git log -1 --format=%B | tail -1` == `Coding by - Muonroi-CLI` ☐ `git log --format=%B | <count> 'Coding by - Muonroi-CLI'` == 1 (no dup) ☐ `%s` non-empty, ≤72 chars, NOT the literal prompt, NOT starting `chore: update` ☐ `show --name-only HEAD` contains `hello.ts` ☐ does NOT contain `user-wip.txt` ☐ `status --porcelain` still shows `?? user-wip.txt` ☐ stdout matches `Committed [0-9]+ file\(s\) →` OR `✓ Auto-committed`
- **Risks:** Cold boot + round-trips → ≥120s. Model may name file differently → assert a committed `*.ts` exists if it deviates. grok stall → one retry. **If model forgets git_commit**, the safety-net commits with a `chore: update` subject → FAILS the "not chore:" check (correctly flags the agent didn't self-commit; do not relax unless testing the backstop itself).

#### F2 · `git-commit-per-step-multiple-commits` — P0
- **Goal:** Two sequential file creations → two OWN commits; the second does not re-stage the first (idempotency via `git diff --cached`).
- **Why:** "commits per chunk / plan step" — reason `auto-commit.ts:213-214` has the `nothing-staged` gate. Guards a catch-all or re-commit.
- **Harness setup:** Same as F1. `-p "Step 1: create a.ts exporting A=1 and git_commit it. Step 2: create b.ts exporting B=2 and git_commit it. Make two separate commits, one per step."`.
- **Steps:** greenfield repo → run two-step prompt → wait exit → `git log --format=%H%n%s` + per-commit `--name-only`.
- **Acceptance:** ☐ `rev-list --count HEAD` ≥2 ☐ a.ts commit `--name-only` does NOT list b.ts ☐ b.ts commit does NOT list a.ts ☐ every new commit `%B` ends `Coding by - Muonroi-CLI` ☐ no commit subject starts `chore: update`
- **Risks:** Model may batch both into one git_commit → `rev-list==1`; if that single commit has BOTH files it's a **model-behavior miss, not a code bug** (downgrade note, don't FAIL the code). Cold boot + 2 steps → ≥150s.

#### F3 · `git-commit-no-writes-and-secret-exclusion` — P1
- **Goal:** (a) git_commit with nothing written → explicit refusal; (b) a secret/artifact the agent wrote is excluded.
- **Why:** writtenPaths empty-guard (`registry.ts:465-471`) + `isExcludedPath` (`auto-commit.ts:201`). Regression → nothing-files noise, or a `.env` leak.
- **Harness setup:** Two greenfield headless sub-runs. A: `-p "Without creating or editing any file, call the git_commit tool with message 'test: nothing'."`. B: `-p "Create config.ts exporting PORT=3000 and also create debug.log containing some text, then git_commit everything with a clear message."` (use `debug.log` — ARTIFACT_RE, models write it freely; `app.key`/`.env` may trip model safety so nothing gets written).
- **Steps:** A: run → assert refusal + no commit. B: fresh repo → run → assert config.ts committed, debug.log excluded + still untracked.
- **Acceptance:** ☐ A: stdout contains `Nothing to commit — you have not created or edited any file` ☐ A: `rev-list --count HEAD` is 0/errors ☐ B: `show --name-only HEAD` contains `config.ts` ☐ B: does NOT contain `debug.log` ☐ B: `status --porcelain` shows `debug.log` as `??` ☐ B: message ends `Coding by - Muonroi-CLI`
- **Risks:** A depends on the model invoking git_commit with no prior write — may refuse a "pointless" tool → no refusal string (false negative). Phrase to explicitly demand the call. B: if the model declines to write the excluded file, the exclusion path isn't exercised — `debug.log` mitigates this.

#### F4 · `git-commit-tui-log-visibility` — P2
- **Goal:** Commit confirmation surfaces in the live TUI log (`Committed N file(s) → <sha>` or `✓ Auto-committed`).
- **Why:** Verifies the user-visible feedback path through the real UI render (id=log/msg-{i}) that headless `-p` doesn't exercise. P2 — git-log proof (F1) already covers correctness.
- **Harness setup:** MCP harness, greenfield temp git repo. `tui_start` model grok-4.3, `MUONROI_AUTO_COMMIT` unset, VITEST unset. Rely on xAI OAuth so api-key modal doesn't grab focus.
- **Steps:** init temp repo → `tui_start` (temp cwd) → `wait_for idle 60000` → if api-key modal grabbed focus, dismiss/pre-seed → type `Create note.md with one line then git_commit it with a conventional message` → Enter → `wait_for {selector:'id=log', 120000}` → poll `tui_query_all role=listitem` → assert git state.
- **Acceptance:** ☐ a `role=listitem` node name/value matches `Committed [0-9]+ file\(s\) →` OR `✓ Auto-committed` ☐ `git log -1 --format=%B | tail -1` == `Coding by - Muonroi-CLI` ☐ `show --name-only HEAD` contains `note.md`
- **Risks:** Highest flakiness: cold boot + api-key modal focus grab + LLM latency + grok stall; `wait_for idle` documented unreliable; **no commit LiveEvent** → must poll listitems. Prefer F1-F3 (deterministic) for the gate; treat this as nice-to-have.

---

### Feature G — Orchestrator resilience: actionable 5xx + transient retry/resume

#### G1 · `err-5xx-forensics-headless` — P0 *(deterministic; runs in tier 1)*
- **Goal:** `humanizeApiError` 5xx canned text + redacted forensics envelope, verified out-of-band where an `APICallError` can be constructed.
- **Why:** Backs the actionable-status promise with the forensics half (`error-utils.ts:170-192`) the live harness can't assert (interaction-log rows aren't LiveEvents). The **only** place a non-harness import is justified — JSON fixtures cannot mint `APICallError.statusCode`. Keep it a thin assertion, not a vitest suite.
- **Harness setup:** Thin headless driver importing `humanizeApiError` + `summarizeApiErrorForLog` from `src/orchestrator/error-utils.ts`. Feed synthetic `APICallError({statusCode:500, responseBody:'{"code":60000,"message":"Request failed: Unknown error."}', requestBodyValues:{model:'x', messages:[], apiKey:'SECRET'}})`.
- **Steps:** construct 500 err → `humanizeApiError(err,{modelId:'deepseek-ai/DeepSeek-V4-Flash',providerId:'deepseek'})` + `summarizeApiErrorForLog(err)` → repeat for 429 (routing suffix) and 402-by-message (`Insufficient Balance` → top-up hint).
- **Acceptance:** ☐ 500 === `The API server encountered an internal error. Please try again later. (HTTP 500)` (opaque body dropped, NO routing suffix) ☐ 429 ends with routing suffix containing modelId + providerId + `switch model with -m <model>` ☐ 402-by-message contains `top up` + routed model ☐ `summarizeApiErrorForLog(err).requestParamKeys` contains only key names (e.g. `apiKey`) NEVER the secret value; `responseBodyTrunc` length ≤1000 ☐ `summarizeApiErrorForLog(non-APICallError)` returns null
- **Risks:** Imports error-utils directly (justified — fixtures can't build `APICallError.statusCode`). Keep thin. If the owner insists on zero non-harness execution, fold the strict 500 assertion into G2 by extending `mock-model.errorStream` to emit an `APICallError`-shaped part.

#### G2 · `err-5xx-actionable-toast` — P0
- **Goal:** Opaque provider 5xx surfaces a canned actionable status via toast + log — not a silent stall, not the opaque body.
- **Why:** Core promise #1 (`2462830`). Guards `isOpaqueDetail`/`status>=500` branch (`error-utils.ts:94-98`) that hid SiliconFlow's "Request failed: Unknown error." for hours.
- **Harness setup:** `tui_start args=['-k','FAKE_KEY_FOR_TESTS','-m','deepseek-ai/DeepSeek-V4-Flash','--mock-llm','<repo>/tests/harness/fixtures/llm-5xx']`, env `MUONROI_TEST_NO_PERSIST=1, MUONROI_NO_SHELL_HOLD=1`, cwd=repo root. Fixture `error-500.json`: single round `[stream-start, {type:'error', error:<…>}, finish(error)]`. **JSON fixtures wrap `error` as a plain Error** → for the strict `HTTP 500` assertion the part must be an `APICallError` (out of pure-harness scope → covered by G1). Pure-harness variant: generic error message `'mock LLM error: simulated provider failure'` → assert toast fires with stripped friendly text (no `AI_...Error:` prefix).
- **Steps:** start → `wait_for idle 120000` → type `hello` → Enter → `wait_for {event:'toast', 45000}` → `tui_last_event 'toast'` → `tui_query 'id=toast'` (.name) + `tui_render_text`.
- **Acceptance:** ☐ `last_event('toast')` non-null AND `level==='error'` ☐ toast text non-empty actionable (NOT empty, NOT raw `AI_APICallError:` prefix) ☐ with an `APICallError-500` fixture: text includes `HTTP 500` AND `try again later` AND excludes `Unknown error`/`Request failed` ☐ same friendly text present in `tui_render_text()` (surfaced in log, not only toast)
- **Risks:** Pure JSON can't construct statusCode → strict `HTTP 500` needs G1 (or extend `mock-model.errorStream`). Generic-Error variant IS harness-runnable today and proves the no-silent-stall promise. Cold boot 25-46s; error-states path may stall pre-streamText → `retry:2` like `error-states.spec.ts`.

#### G3 · `err-part-transient-retry-event` — P0
- **Goal:** A transient `{type:'error'}` part **before any content** triggers the bounded no-content retry (shared `streamRetryCount`/`MAX_STREAM_RETRIES=2`) and emits `stream-retry` source `error-part`.
- **Why:** Core promise #2 (`efa8485`). An error-part used to end the turn (observed: SiliconFlow 500 ended a multi-step turn). Guards `msg-processor.ts:2791-2856`.
- **Harness setup:** `tui_start args=['-k','FAKE_KEY_FOR_TESTS','-m','deepseek-ai/DeepSeek-V4-Flash','--mock-llm','<repo>/tests/harness/fixtures/llm-transient-retry']`, env `MUONROI_TEST_NO_PERSIST=1, MUONROI_NO_SHELL_HOLD=1, MUONROI_HARNESS_EVENTS=lifecycle`, cwd=repo root. Fixture `error-then-text.json` NESTED rounds: round1 `[stream-start, {type:'error', error:'fetch failed'}, finish(error)]` (NO text-delta); round2 `textOnlyStream('recovered: done')`. `classifyStreamError` treats `'fetch failed'`/5xx as transient.
- **Steps:** start → idle 120000 → type `hello` → Enter → `wait_for {event:'stream-retry', 45000}` → `last_event('stream-retry')` → `wait_for {selector:'id=log', 30000}` + `render_text` confirms `recovered: done`.
- **Acceptance:** ☐ `last_event('stream-retry')` non-null, `attempt>=1`, `maxAttempts===3` ☐ round2 `recovered: done` appears in `render_text` (continue resumed, turn didn't terminate) ☐ NO terminal `level:'error'` toast precedes the successful render (`last_event('toast')` null OR not level error at completion)
- **Risks:** `'fetch failed'` plain-Error is the simplest JSON route (no APICallError). round1 must emit NO text-delta before the error. Nested-array round sequencing supported. Cold boot; pre-streamText stall → `retry:2`.

#### G4 · `err-part-resume-after-tool-step` — P0
- **Goal:** A transient error-part AFTER a completed tool step grafts completed steps onto history and re-issues (`stream-retry` source `error-part-continuation` + warning toast "resuming"), then finishes — no freeze, no tool re-run.
- **Why:** Core promise #3 and highest-value fix (`f7774b7`) — the "fail liên tục" case (read big file → finish-step → 500). Guards `msg-processor.ts:2857-2944` incl. `appendedMessages>0` gate + `midLoopStallRetryCount` bound (default 1).
- **Harness setup:** `tui_start args=['-k','FAKE_KEY_FOR_TESTS','-m','deepseek-ai/DeepSeek-V4-Flash','--mock-llm','<repo>/tests/harness/fixtures/llm-resume','--yolo']`, env `MUONROI_TEST_NO_PERSIST=1, MUONROI_NO_SHELL_HOLD=1, MUONROI_PROVIDER_STALL_RETRIES=2, MUONROI_HARNESS_EVENTS=lifecycle`, **greenfield temp cwd**. Fixture `resume.json` NESTED 3 rounds: round1 `toolCallStream({toolCallId:'c1', toolName:'bash', input:{command:'echo hi'}})` (finish tool-calls); round2 `[stream-start, {type:'error', error:'fetch failed'}, finish(error)]` (AFTER tool step → no-content guard skips → continuation path); round3 `textOnlyStream('resumed and finished')`.
- **Steps:** start → idle 120000 → type `run echo hi then summarize` → Enter → `wait_for {event:'stream-retry', match: e=>e.errorMessage?.includes('after tool step'), 60000}` → `last_event('stream-retry')` → `wait_for {event:'toast', match: e=>e.level!=='error' && /resum/i.test(e.text), 10000}` → `wait_for {selector:'id=log', 30000}` + `render_text` confirms `resumed and finished`.
- **Acceptance:** ☐ a `stream-retry` event with `errorMessage` containing `after tool step` (continuation branch, not no-content) ☐ a toast `level !== 'error'` AND text matching `/resum/i` ☐ round3 `resumed and finished` in `render_text` ☐ the bash tool result appears exactly once in `render_text` (no re-run — steps grafted) ☐ NO terminal `level:'error'` toast at completion
- **Risks:** Most setup-sensitive. (a) round1 tool-call result must be appended before round2 (AI SDK runs the builtin tool under `--mock-llm`). (b) `--yolo` (or no-approval tool) required else it blocks on `tool_approval_request`. (c) `MUONROI_PROVIDER_STALL_RETRIES=2` so an earlier mid-loop retry doesn't exhaust the budget. (d) `result.response` races a 3s timeout → slow child misses graft (`appended=0`) → falls through to surface error → generous timeouts. (e) greenfield cwd. `retry:2`.

---

### Feature H — Harness opt-in extra cwd roots

> **Key correction:** extra roots are read from the **SERVER's** own `process.env.MUONROI_HARNESS_EXTRA_ROOTS` + the **server's-cwd** `.muonroi-harness-roots.json` — NOT from `tui_start({env})`/`({cwd})` args (those reach the child only via `sanitizeEnv`, AFTER `validateCwd`). Local checkout has a gitignored `.muonroi-harness-roots.json` with `roots:["D:\\sources\\Core"]`, so the live harness already permits `D:\sources\Core\*`.

#### H1 · `extra-root-allows-sibling-repo-cwd` — P0
- **Goal:** `tui_start` accepts a sibling repo under a configured extra root (outside `$HOME` and the muonroi-cli checkout) — `ok:true` + driveable composer.
- **Why:** Core dogfood promise (`18d0373`). Failure = ecosystem dogfooding impossible. Guards against `validateCwd` ignoring `loadExtraRoots` or win32 path-split corrupting the drive letter.
- **Harness setup:** Live `muonroi-harness` MCP (its cwd = `D:\sources\Core\muonroi-cli`, where the JSON lists `D:\sources\Core`). Rebuild dist + reconnect if testing freshly-built. Target `D:\sources\Core\experience-engine`.
- **Steps:** ① out-of-band: `git -C D:/sources/Core/muonroi-cli check-ignore .muonroi-harness-roots.json` exit 0 + roots contains `D:\\sources\\Core` ② `tui_start({args:['--agent-mode'], cwd:'D:\\sources\\Core\\experience-engine'})` ③ parse result JSON ④ `wait_for {idle:true, 60000}` ⑤ `tui_query 'id=composer'` ⑥ `tui_stop`.
- **Acceptance:** ☐ result JSON `ok===true` + numeric `pid`; NOT `error:'cwd_rejected'` ☐ `wait_for idle` resolves <60s ☐ `tui_query('id=composer')` returns a node `role==='textbox'` ☐ `git log --oneline` shows `18d0373` touching `packages/agent-harness-core/src/mcp-server.ts`
- **Risks:** Cold boot 25-46s → 60000ms. If the server was started in a cwd without the JSON / without the env, it correctly rejects — verify the server cwd has the file before blaming code. api-key modal focus grab doesn't affect the cwd gate (start already returned ok) — assert composer role only, not focus.

#### H2 · `clean-deny-outside-all-roots` — P0
- **Goal:** A guaranteed-outside path is rejected with the exact `cwd_rejected` reason; no process spawns.
- **Why:** Default-deny must hold WITH extras present. Guards an over-broad `startsWith` or accidental allow-all — the escape-to-arbitrary-dirs security regression.
- **Harness setup:** Same live server. Negative cwd win32 `C:\Windows` (exists, outside home/repo/`D:\sources\Core`, different drive).
- **Steps:** `tui_start({args:['--agent-mode'], cwd:'C:\\Windows'})` → parse JSON → do NOT `wait_for`; `tui_snapshot` to confirm no driver.
- **Acceptance:** ☐ result JSON `error==='cwd_rejected'` ☐ reason exactly `cwd escapes home, repo root, and configured extra roots` ☐ `tui_snapshot` afterward returns `{error:'no_driver'}` (or null)
- **Risks:** On CI/posix use `/`. Different drive than the extra root makes the negative robust (`C:` vs `D:`).

#### H3 · `tui-start-env-does-not-add-root` — P1
- **Goal:** Passing `MUONROI_HARNESS_EXTRA_ROOTS` inside `tui_start({env})` does NOT authorize an otherwise-rejected cwd (server-process scoping).
- **Why:** `loadExtraRoots` reads the SERVER's `process.env` (`mcp-server.ts:106`), not `input.env`. Pins the real opt-in surface so future readers don't assume `tui_start({env})` is a vector.
- **Harness setup:** Best run against a SECOND mcp-driver started in a temp cwd with NO JSON and NO env. If only the always-on live harness is available (which allows `D:\sources\Core`), pick a target OUTSIDE `D:\sources\Core`, e.g. pre-created `D:\harness-env-test`.
- **Steps:** pre-create `D:\harness-env-test` → `tui_start({args:['--agent-mode'], cwd:'D:\\harness-env-test', env:{MUONROI_HARNESS_EXTRA_ROOTS:'D:\\harness-env-test'}})` → parse JSON.
- **Acceptance:** ☐ result JSON `error==='cwd_rejected'` despite the env naming that cwd ☐ no `pid`; `tui_snapshot` returns `no_driver`
- **Risks:** If the runner reuses the live harness whose JSON lists `D:\sources\Core`, the target MUST be outside it. Pre-create the dir (else reason becomes "cwd does not exist or unreadable" — also a reject; accept either reason or pre-create for the sharper `escapes-roots` reason).

#### H4 · `unresolvable-extra-root-is-skipped-not-fatal` — P2
- **Goal:** A bogus configured root is skipped (logged), and a valid sibling cwd still works.
- **Why:** `validateCwd` wraps `realpathSync(extra)` in try/catch, skips with a stderr log (`mcp-server.ts:142-146`) rather than throwing. One stale JSON entry must not brick the harness or widen access.
- **Harness setup:** Dedicated mcp-driver in a temp cwd whose `.muonroi-harness-roots.json` = `{roots:["D:\\does-not-exist-xyz","D:\\sources\\Core"]}`; `bun run <repo>/src/index.ts mcp-driver 2> server.stderr.log`.
- **Steps:** `tui_start cwd='D:\\sources\\Core\\muonroi-building-block'` → expect ok → idle 60000 → stop → grep `server.stderr.log` for the skip line → `tui_start` cwd under bogus root → expect reject.
- **Acceptance:** ☐ valid-root cwd returns `ok:true` + pid + reaches idle ☐ `server.stderr.log` contains `extra cwd root unresolved, skipping: D:\\does-not-exist-xyz` ☐ bogus-root cwd returns `error==='cwd_rejected'` (server doesn't crash; a subsequent valid `tui_start` still works)
- **Risks:** Needs side-channel server + stderr capture. If stderr uncapturable, fall back to the two `tui_start` JSONs (valid→ok, bogus→reject); log assertion best-effort. Stop the temp server after to avoid pipe collisions.

---

## 3. Cross-feature / regression smokes

#### X1 · Auto-commit backstop defers when `git_commit` already ran (E ∩ F)
- **Goal:** Confirm no double-commit when the agent self-commits — the snapshot-diff dedup, exercised across both the agent-commit path AND the backstop.
- **Setup/assert:** Identical to E4 (`autocommit-noop-when-agent-committed`). One commit (`feat: add bar`), zero `chore: update`, no `✓ Auto-committed` chunk. **This is the canonical interaction smoke — run E4 to satisfy X1.**

#### X2 · Council token-thrift still surfaces askcards / completes a debate (D ∩ council lifecycle)
- **Goal:** The conciseness rule didn't suppress the council's interactive surfaces — a `--force-council` run still emits `council-step`/`council-speaker` and renders debate turns (and, where the flow asks, an askcard).
- **Setup:** Reuse D3 harness (greenfield, EE-down, grok-4.3, `/council`). Additionally, if any phase opens an askcard, `wait_for {event:'askcard-open'}` and `tui_press Enter` to accept default; confirm the run proceeds to `phaseKind='opening' state='done'`.
- **Acceptance:** ☐ `council-step opening done` observed ☐ ≥1 debate `council_message` rendered ☐ if an askcard opens, it accepts and the debate continues (no hang) — proves token-thrift left the council interaction loop intact.

#### X3 · EE recall marker survives compaction (A ∩ orchestrator compaction)
- **Goal:** After B3/B4 sub-agent/top-level compaction, the injected `[id:..]` markers + nudge remain in the enriched prompt (they live in the system prompt, not in compactable tool-result parts).
- **Setup:** A long headless `-p` session with `MUONROI_PIL_UNIFIED=1` + thin EE + a prompt that forces many tool calls past `MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS` (or lower it via env), `MUONROI_DEBUG_LLM_WIRE=1 2>wire.log`.
- **Acceptance:** ☐ after a compaction occurs (older tool_results show `[elided by … compactor]` in `wire.log`/forensics), a later assembled prompt in `wire.log` STILL contains a `[id:..]` marker + `Rate it: ee_feedback` (markers in `enriched` system prompt are untouched by compaction) ☐ `ee_injection` rows still record `pointIds` after compaction turns. *SKIP if EE thin-client unavailable.*

#### X4 · 5xx actionable status doesn't trigger a spurious auto-commit (G ∩ E)
- **Goal:** A turn that ABORTS on a surfaced 5xx error must NOT run the turn-end backstop (the backstop is reached only on normal completion; an abort/throw propagates through `yield*` and skips it, `orchestrator.ts:2513-2514`).
- **Setup:** Greenfield git repo. Reuse G2's 5xx fixture but have round1 first `write_file` a file, THEN emit the terminal error part (so a file is dirty when the turn errors). Run headless.
- **Acceptance:** ☐ the surfaced error toast/text appears ☐ `git rev-parse HEAD` unchanged (no `chore: update` commit) ☐ no `✓ Auto-committed` in stdout — proves the abort path skips the backstop and an errored turn doesn't silently commit half-written work.

#### X5 · MCP `ee_write` and CLI ledger are separate processes (C ∩ A negative control)
- **Goal:** Confirm the documented process boundary: an external `mcp__muonroi-tools__ee_feedback` does NOT clear the in-CLI `sessionRecallLedger`.
- **Setup:** Run A4 turn-1 to record `ledgerPending P1`. Instead of the native builtin, issue `mcp__muonroi-tools__ee_feedback` (external process) for the surfaced id. Run A4 turn-2.
- **Acceptance:** ☐ turn-2 still lists the same id in pending (P2 does NOT drop it) — proves external MCP feedback does not touch the CLI's module-scoped ledger (only the in-process native builtin does, per A4). *Run only if A4 passed.*

---

## 4. Sign-off gate

**ALL of the following P0 acceptance checks must pass (or be a justified SKIP with EE-down evidence) before declaring the merged features live on master.** Run in this order; a hard FAIL blocks promotion.

| Gate | Scenario | Binary sign-off check |
|---|---|---|
| G-1 | `council-conciseness-static-grounding` (D1) | `git show 871aefd --stat` = 1 file/+25; `concisenessRule` at 220/160/140; no maxTokens <4096; rule free of all 4 routing substrings; `bunx vitest run src/council/` 0 failed |
| G-2 | `unified-budget-default-3500` (A1) | budget 3500/clamp 1000..8000; flag false unset / true at `=1` |
| G-3 | `err-5xx-forensics-headless` (G1) | `humanizeApiError(500)` == canned `(HTTP 500)` text, opaque body dropped, no routing suffix; `requestParamKeys` keys-only (no secret value), `responseBodyTrunc` ≤1000 |
| G-4 | `ee-write-advertised-over-stdio` (C1) | rebuilt `dist` `listTools` includes `ee_write` with `lesson` required + 2-value `collection` enum; siblings still present |
| G-5 | `autocommit-backstop-headless-positive` (E1) | new commit, subject `chore: update 1 file(s) — foo.txt`, body has `Coding by - Muonroi-CLI`, `--name-only` == exactly `foo.txt`, `✓ Auto-committed` in stdout |
| G-6 | `autocommit-respects-dirtybefore-and-exclusions` (E2) | commit == exactly `['agent.txt']`; `.env` + `user_wip.txt` never staged, still dirty (secret-leak / WIP-sweep guard) |
| G-7 | `err-part-transient-retry-event` (G3) | `stream-retry` event `maxAttempts===3`; round2 recovery text renders; no terminal error toast |
| G-8 | `err-part-resume-after-tool-step` (G4) | `stream-retry` `errorMessage` contains `after tool step`; resume toast `/resum/i`; round3 renders; tool result appears exactly once |
| G-9 | `extra-root-allows-sibling-repo-cwd` (H1) | `tui_start` sibling cwd → `ok:true`+pid, composer present |
| G-10 | `clean-deny-outside-all-roots` (H2) | outside cwd → `cwd_rejected` exact reason, no driver spawned |
| G-11 | `ee-write-roundtrip-recall` (B1) **or** `ee-write-roundtrip-real-ee` (C2) | sentinel written `ok:true` + recallable via `ee_query` (one of native/MCP arm). SKIP both only if `ee_health` `{ok:false}` |
| G-12 | `git-commit-agent-message-attribution` (F1) | agent-authored subject (≤72, not prompt, not `chore:`), exactly one attribution line, only `hello.ts` staged, `user-wip.txt` untouched |
| G-13 | X1 (= E4) | self-commit case produces ONE commit, zero backstop `chore:`/`✓ Auto-committed` |

**Live-LLM P0s** (B1/C2, F1, D2 `council-debate-turn-wordcap-headless`) may be retried **once** for a grok mid-turn stall before being marked FAIL. **Deterministic P0s** (D1, A1, G1, C1, E1, E2, G3, G4, H1, H2) must pass **without** retry — a flake there is a real defect.

**Promotion verdict = green** iff G-1…G-13 all pass (EE-dependent G-11 may be a documented SKIP), AND no cross-feature smoke (X1, X4) shows a double-commit or silent-commit-on-error regression.

---

**Evidence-grounding note for operators:** Every `file:line` in this plan was carried verbatim from the per-feature specs; spot-checked live this session — `git show 871aefd --stat` (1 file `src/council/prompts.ts` +25 −0), `src/pil/config.ts:7-26` (flag default-OFF, budget 3500 clamp [1000,8000]), and all 16 commit SHAs confirmed on HEAD. EE confirmed reachable (`exp-recall.js` returned live hits). The running `muonroi-tools` MCP binary in this session predates the merge (no `ee_write` advertised) — **rebuild dist + reconnect is the first action** for any C-feature scenario.