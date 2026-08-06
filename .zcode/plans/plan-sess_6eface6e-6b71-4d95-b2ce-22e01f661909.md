# Plan: Convergence Mirror — kết hợp 4 hướng chống fumble (agent-first)

## Bối cảnh & bằng chứng

Session `d0fbdd730b08`: user nhập `"k"` → agent fumble 42 tool calls (24 grep với 24 pattern khác nhau tìm cùng thứ + 13 read_file) + 5 lần "let me reconsider" trong reasoning, 2M tokens. Agent không tự nhận ra fumble vì mỗi step thấy "data mới". System prompt có rule "MAX 2 ROUND TRIPS" nhưng agent không tuân.

**Root cause** (từ 3 agent audit): agent thiếu **visibility vào bức tranh riêng tư của chính nó giữa các step**. Có `ask_user`, có `ee_query`, có rule CLARIFY — nhưng tất cả frame cho "trước khi code", không cho "đang explore mà không converge". 

## Triết lý thiết kế (theo nguyên tắc bạn đã bảo vệ)

**Observe + nudge, KHÔNG intervention cưỡng bức.** Hệ thống:
- ✅ **Reflect** sự thật về tool history (mirror) — model thấy bức tranh
- ✅ **Gợi ý** (passive hint) khi convergence thấp — trỏ tới `ee_query` / `ask_user`
- ❌ **KHÔNG** auto-block turn, KHÔNG auto-fire ask_user, KHÔNG hardcode threshold "N lần rồi stop"

**Detection**: structural observation (đa dạng grep pattern nhắm cùng concept = tín hiệu low-convergence). Không phải rule cấm, chỉ là số liệu đưa cho model — model tự quyết.

## Kiến trúc — 1 carrier note thay vì 4 tính năng rời

Thay vì làm 4 thứ riêng lẻ, mình tích hợp thành **một "Convergence Mirror" note** được inject mỗi step qua primitive đã có (`attachReminderToMessages` ở `scope-reminder.ts:179`). Note chứa:

```
[step 5 mirror] This turn: 8 tool calls across 4 steps.
  grep×5 (patterns: 'clipboard image', 'pin.*todo', 'resume session',
         'task_list_update', 'pinboard') — 5 distinct queries, concept
         overlap: HIGH (all target the resume/todo-pin issue).
  read_file×3 (tool-engine.ts, orchestrator.ts, message-processor.ts).
  Output gained: 14KB → 2.1KB last step (declining).
  → Convergence: LOW. You've tried 5 angles on the same target.
    Consider: (a) ask_user "what specific symptom? before/after steps?"
              when you can't decide the next read, or
              (b) ee_query "exploring without converging on resume bug"
              to recall if a past similar exploration was a dead-end.
```

Đây là **single primitive** mang theo cả 3 gợi ý (mirror + EE hint + ask_user reminder) chỉ khi convergence thực sự thấp. Khi convergence cao → note ngắn hoặc vắng.

## 4 hướng được kết hợp

### Hướng 1 — Tool-call mirror (core)
**File mới:** `src/orchestrator/convergence-mirror.ts` (~200 LOC)

Pure function `buildConvergenceMirror(stepMessages, opts)`: đọc `stepMessages` (prior assistant+tool messages do SDK cung cấp cho `prepareStep`), returns string note hoặc `""` (vắng nếu không có gì đáng mirror).

Logic:
- Đếm tool calls theo loại (grep/read_file/bash/...) với args digest
- Tính "concept overlap" giữa các grep pattern — **không phải match keyword** mà là đo lấp结构性: nếu N grep trong 1 window đều có ít nhất 1 token chung (sau lowercase + stemming đơn giản), flag "concept overlap: HIGH". Đây là observation, không phải rule.
- Tính "output growth" — nếu tổng tool output đang giảm dần trong 3 step gần nhất → "declining" (tín hiệu model đang thu thập ít thông tin mới)
- Verdict: LOW / MEDIUM / HIGH convergence — computed, không hardcode "if N>=3"

**Wiring**: trong `prepareStep` ở `tool-engine.ts:1946`, hiện đang return `withSteers({ messages: attachReminderToMessages(stepMessages, reminder) })`. Mình thêm 1 bước: build mirror note, append vào `reminder` (hoặc attach riêng). **KHÔNG** thêm vào `deps.messages` (chỉ là view per-step, đúng như agent audit khuyến nghị — tránh bị `stripInterToolNarration` xóa).

Tương tự cho sub-agent path ở `stream-runner.ts:677`.

### Hướng 2 — EE recall gợi ý (passive hint)
**KHÔNG** auto-fire EE query (vi phạm agent-first). Thay vào đó, khi mirror verdict = LOW, note tự động kèm dòng gợi ý:
```
→ ee_query "exploring without converging on <topic>" may surface
  whether a similar past exploration was a dead-end.
```

Topic được extract từ grep patterns (group by shared token) — không phải tag hardcode, là structural. Model tự quyết gọi `ee_query` hay không. Nếu EE down → hint vẫn xuất hiện nhưng `ee_query` trả `ee_unavailable` (graceful degrade đã có sẵn).

Hướng đi tương lai (out of scope commit này): `ee_write` khi agent tự nhận ra fumble và sửa được → lần sau recall dễ hơn. Đây là loop tự reinforcement đã có sẵn — mình chỉ kích hoạt hint.

### Hướng 3 — ask_user prompt semantics mở rộng
**File:** `src/tools/registry.ts:338-339` (ask_user description) + `src/orchestrator/prompts.ts:348` (CLARIFY rule)

Hiện tại: *"Use when you need a decision, confirmation, or missing detail"* — chỉ frame cho before-build.

Mở rộng description thành:
> "Use when you need a decision, confirmation, missing detail — **OR when you've been exploring (multiple searches/reads) without converging on a clear next step**. Asking the user one focused question is cheaper than 5 more speculative tool calls."

Thêm 1 rule ngắn vào WORKFLOW RULES ở `prompts.ts:~352`:
> "- EXPLORE STALL: If you've called 4+ exploratory tools (grep/read) in a turn without a clear next action emerging, pause and call `ask_user` with one focused question — do NOT keep speculating."

Đây là **cập nhật prompt semantics**, không phải threshold cứng. "4+" là gợi ý cho model, không phải counter enforce. Model vẫn quyết.

### Hướng 4 — KHÔNG làm (deliberate defer)
Audit khuyến nghị dùng `createLlmClassifier`-shaped call trong `stopWhen` predicate để auto-detect fumble. Mình **defer** cái này vì:
- Thêm 1 LLM call mid-turn = breakdown agent-first (dù nhỏ)
- Discovery re-fire sẽ bị rule 5 ("return [] on follow-ups") suppress
- Mirror (hướng 1) đã cung cấp signal model cần — model tự detect bằng cách đọc note

Nếu sau nàyMirror proves insufficient (agent vẫn fumble dù note hiển thị rõ), lúc đó mới cân nhắc hướng 4. Đây là incremental, không phải workaround — mình để model tự học trước.

## Phạm vi KHÔNG chạm vào

- ❌ `MAX_TOOL_ROUNDS` / cap (bạn đã phản đối — workaround)
- ❌ `compaction.ts` timing (không phải root cause)
- ❌ `ask_user` tool logic execute (chỉ update description)
- ❌ `discovery.ts` re-fire (defer theo hướng 4)
- ❌ EE write side (tự loop khi agent học)
- ❌ Headless mode (ask_user silent-dismiss đã có — mirror vẫn hoạt động ở đó vì chỉ là note)

## Test strategy

**File mới:** `src/orchestrator/__tests__/convergence-mirror.test.ts` (~150 LOC)

```ts
describe("buildConvergenceMirror", () => {
  it("returns empty for first step (no history)", () => {});
  it("returns short tally for 1-2 tools (no convergence verdict)", () => {});
  it("flags HIGH concept overlap when N greps share a token", () => {
    // 5 greps: 'clipboard image', 'pin.*todo', 'resume session',
    // 'task_list_update', 'pinboard' — tất cả contain "pin" or "todo"
    const note = buildConvergenceMirror([...]);
    expect(note).toContain("concept overlap: HIGH");
    expect(note).toContain("Convergence: LOW");
    expect(note).toContain("ask_user");  // hint present
    expect(note).toContain("ee_query");  // hint present
  });
  it("does NOT flag overlap for genuinely distinct searches", () => {
    // grep 'auth' + grep 'database' + grep 'logging' — distinct
    const note = buildConvergenceMirror([...]);
    expect(note).not.toContain("Convergence: LOW");
  });
  it("detects declining output signal", () => {
    // tool outputs: 5KB → 3KB → 1KB across 3 steps
    const note = buildConvergenceMirror([...]);
    expect(note).toContain("declining");
  });
  it("does not flag declining when output is stable", () => {});
  it("extracts topic from grep patterns for the ee_query hint", () => {});
});
```

**Integration**: 1 test trong `tool-engine` existing test suite — verify `prepareStep` return chứa mirror note khi có fumble-shape stepMessages.

**Existing tests phải vẫn xanh**: mọi test `tool-engine` / `stream-runner` / `scope-reminder` / `prompts` không đổi behavior.

## Verification gates

1. `npx tsc --noEmit` — 0 errors
2. `bunx vitest run src/orchestrator src/pil src/tools` — xanh
3. `bunx vitest run` (full suite) — Pre-Push Test Gate: 0 failed
4. `selfverify_*` — pre-push hook tự chạy
5. **Dogfood replay**: chạy script `analyze-cost-leak.ts` trước/sau (nếu user re-run session `d0fbdd730b08` shape) — số calls/turn nên giảm nếu mirror hoạt động. Đây là measurable outcome, không phải đoán.

## Risk assessment

- **Low risk**: mirror là pure function, output là string. Worst case model bỏ qua note → behavior giống cũ, không regression. Không bao giờ block turn.
- **Điểm cẩn thận**: note phải đủ compact để không blow context. Mình cap note ở ~500 chars (tính trong `buildConvergenceMirror`), chỉ gợi ý khi verdict != HIGH.
- **False positive**: structural overlap detection có thể flag "HIGH" khi agent đang làm task legitimately cần explore nhiều biến thể (vd refactor diện rộng). Mitigation: chỉ gợi ý (hint), không block — agent tự quyết.
- **Token cost**: mirror note ~300-500 chars (~100 tokens) mỗi step. Với 35-step turn = +3.5K tokens trên 2M tokens đã burn = +0.17%. Đáng đổi lấy visibility.

## Thứ tự thực thi (1 commit atomic)

1. Tạo `convergence-mirror.ts` với `buildConvergenceMirror` + tests.
2. Wire vào `tool-engine.ts:1946` `prepareStep` (1 dòng thêm: build mirror, append vào reminder).
3. Wire vào `stream-runner.ts:677` (sub-agent path, cùng pattern).
4. Update `ask_user` description (registry.ts) + thêm EXPLORE STALL rule (prompts.ts).
5. Verify tsc + test + selfverify.
6. Commit với message cite: session `d0fbdd730b08` (evidence), 4 hướng kết hợp, lý do defer hướng 4, measurable outcome gate.

## Tóm tắt vì sao đây là "bài toán tuyệt vời"

Không phải vì phức tạp — mà vì **1 primitive (mirror note) giải quyết 3 gap cùng lúc**:
- Visibility gap (hướng 1): agent thấy history của chính nó
- Tooling gap (hướng 3): agent biết ask_user dùng được khi stuck, không chỉ before-build
- Memory gap (hướng 2): agent có đường tới kinh nghiệm quá khứ khi fumble

Và **tôn trọng absolute agent-first**: model quyết dùng hint hay không, hệ thống không bao giờ cưỡng bức. Nếu model vẫn fumble sau mirror, đó là vấn đề model — lúc đó mới cân nhắc can thiệp mạnh hơn (nhưng vẫn agent-first: qua prompt, không qua logic cứng).