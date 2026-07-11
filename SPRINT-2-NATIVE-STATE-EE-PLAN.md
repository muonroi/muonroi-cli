# Sprint 2: Native Council Workflow + Hierarchical State + EE Differentiation

## IMPL-1 — MVP đã implement (branch `feat/native-state-ee`, typecheck xanh, 45 test mới)

> Ship theo scope REV-2/REV-3 (giữ `.muonroi-flow/`, hierarchy/EE/Part B–E DEFER).
> Tất cả test mới xanh; typecheck sạch; các fail của `sprint-runner*.test.ts` là
> **pre-existing trên develop** (fail y hệt khi revert code của tôi) — 0 regression.

| Deliverable | Trạng thái | File |
|---|---|---|
| `research.md` / `context.md` first-class trong run dir | ✅ | `flow/run-artifacts.ts`, `loop-driver.ts` (discover + research stage) |
| **Resume Digest có nội dung** (thay one-liner) — gốc "resume mù" | ✅ | `run-artifacts.ts` (render/parse), `loop-driver.ts` ×3 stage, `sprint-runner.ts` |
| `sprints/<n>-outcome.json` + `<n>-verify.md` | ✅ | `run-artifacts.ts`, `sprint-runner.ts` |
| `/ideal resume\|status\|review` (review MỚI; status/resume show digest+scores) | ✅ | `ui/slash/ideal.ts`, `product-loop/index.ts` (runReview, runStatus, runResume), `orchestrator.ts` |
| Fold `.planning` → `.muonroi-flow/planning/` — **net-new, non-destructive, marker-guarded, byte-preserving** | ✅ | `flow/fold-planning.ts` |
| phase-sync/config-loader **read-fallback** layout mới (`.planning` vẫn thắng khi tồn tại → 0 desync) | ✅ | `gsd/paths.ts` (`planningRoot`), `config-loader.ts`, `phase-sync.ts` |

**Quyết định kỹ thuật quan trọng (theo Kill B, verify tận code):** fold là **copy-only,
staged**. Đã xác nhận `paths.ts` (read) + subprocess `gsd-tools.cjs` (write `.planning`)
đồng bộ CHỈ vì cùng trỏ `.planning`. Không thể cutover read sang `.muonroi-flow/planning`
khi writer (Part B) chưa gỡ → sẽ desync. Nên: migration COPY (không xoá), read-fallback
chỉ dùng folded khi `.planning` vắng mặt. Live cutover **chờ Part B** (đúng staged 2-bước
như §3.3). `/ideal` = product mode nên phase-sync bị skip (`phase-sync.ts:164`) — fold **0
giá trị cho resume-mù**, nên nỗi đau thật đã được giải bởi 4 deliverable đầu (run-centric),
không phải bởi fold.

**DEFER (chưa làm, đúng plan):** Part B (gỡ SDK), Part C (per-turn EE), Part D (EE server),
Part E (web-research catalog), hierarchy milestone/phase-store, `/api/workflow-event`.

---


> Kế thừa `SPRINT-1-COUNCIL-MIGRATION-PLAN.md`. Mục tiêu Sprint 2: gỡ sạch SDK
> ngoài, dựng state phân cấp kiểu-GSD nhưng native, và dùng Experience Engine
> (EE) làm điểm khác biệt cốt lõi với GSD nguyên bản.

---

## REV-2 — Sửa sau vòng council đập plan (4 sub-agent) + tự verify

> 4 sub-agent adversarial đọc code thật; tôi verify lại các claim load-bearing —
> **tất cả đều đúng**. Các mục dưới đây **ghi đè** phần tương ứng bên dưới.

### Kill #1 — ĐỔI tên thư mục: KHÔNG dùng `.muonroi-cli/`
`.muonroi-cli/environment.json` **đã là** verify-manifest contract cấp project
(`src/orchestrator/prompts.ts:706-708`); `~/.muonroi-cli/` là home global. Dùng
lại tên này = đụng cả hai → **loại**. **Quyết định mới: giữ `.muonroi-flow/`** làm
gốc state (đổi tên ít lợi, nhiều rủi ro). `.planning/` (GSD native) fold vào
`.muonroi-flow/planning/`. Bỏ toàn bộ mục "hợp nhất về .muonroi-cli/".

### Kill #2 — Migration là NET-NEW, không phải "mở rộng"
`src/flow/migration.ts` migrate `.quick-codex-flow → .muonroi-flow` (sai nguồn,
lại là **dead code** — không caller). `.muonroi-flow → hierarchy` + `.planning`
fold phải **viết mới**, wire vào startup gate, guard bằng marker `.migrated`
(KHÔNG guard bằng "dir tồn tại" — vì `ensureFlowDir` tạo dir rỗng làm skip vĩnh
viễn). Map **đủ mọi file thật**: `decisions.lock.md` (chứa quyết định council giá
trị nhất), `iterations.md`, `gray-areas.md`, `manifest.md`, `history/*`, con trỏ
`Active Run` + file `active-run` + `activeRunStore`. Assert bảo toàn byte/file.

### Kill #3 — `/api/workflow-event` + `workflow_*` là NET-NEW server, không tái dùng được
- `phase-outcome` **không lưu experience mới** — chỉ reinforce point ID có sẵn
  (`experience-engine/.experience/src/phase-outcome.js`), và `recordCouncilOutcome`
  gửi payload **không có `toolEventIds`** → **no-op hiện tại**. Bỏ ý "mở rộng
  /api/phase-outcome".
- Thêm collection vào `config.js` **vô dụng cho recall**: core đọc `COLLECTIONS`
  của `intercept.js`, và recall là **3 call hardcode** (`experience-core.js:179-181`)
  chứ không loop. Phải sửa `intercept.js` + unroll fan-out N-way.
- Endpoint `phase-outcome` còn **default OFF** (`server.js` gate `ENABLE_PHASE_OUTCOME=1`).

### Kill #4 — Intra-session recall (§5.5) = memory-poisoning, BỎ khỏi sprint này
Không có đường `superseded` trong 1 phiên → lesson sai sprint-1 tiêm vào mọi lượt
sprint-2, không có vòng sửa. **Đổi luật:** chỉ recall experience của sprint trước
**sau khi verify của nó PASS** (gate-on-outcome, không gate-on-occurrence). Defer
tier `intra-session` sang milestone sau.

### Kill #5 — Per-turn recall: HẠ xuống per-stance-once, không per-turn
Recall **phải await** (không thể tiêm cái chưa nhận) → nằm trên critical path, mâu
thuẫn "fire-and-forget". Cache `(stance,topic-hash)` là **hằng số** qua các round →
hoặc lặp y hệt (tax token vô ích) hoặc phá cache (N× latency). Cap 1.5s
(`council-bridge.ts:16`) < pipeline thực ~8s → phần lớn **timeout rỗng**. **Đổi:**
giữ 1 seed recall trước debate; nếu muốn phân hoá stance thì **1 recall/stance lúc
opening** (2-4 call), cache, tiêm tham chiếu — KHÔNG await trong vòng round.

### Kill #6 — Part E sai tiền đề: web-search ở TOOL layer, không ở model
`web_search` = hardcode Tavily, provider-agnostic (`src/tools/research.ts:134-214`);
**không có** code gọi xAI Live Search / OpenAI Responses `web_search` trong
`src/providers/`. Flag `native_web_research` sẽ **không gate cái gì chạy được**. Và
`internetFirst` + Research Gap warning **đã plumbed sẵn** (`council/llm.ts:739-788`,
`debate.ts:351`, `types.ts:304`) → P6b #19 thừa. **Đổi Part E thành:** *"viết
provider adapter cho native browsing (xAI Live Search, OpenAI web_search) trong
`src/providers/strategies/` TRƯỚC, rồi mới thêm flag gate lên nó"* — hoặc **cắt**
khỏi sprint này. Không thêm flag + drift-test cho capability không ai gọi.

### Kill #7 — Sequencing/rollback
- **Bỏ hẳn cờ legacy + xoá dep `@opengsd/gsd-core` cùng P3** = mất mọi fallback nếu
  native reimpl có bug. **Đổi:** giữ dep + cờ **1 release** làm rollback, xoá sau
  khi native soak qua contract test.
- Ship EE (P5) + bật flag trên hosted brain **TRƯỚC** release CLI gọi endpoint mới;
  client phải **drop (không queue) 404** để tránh head-of-line poison.
- File-map Part B sai path: **không có `src/gsd/native/`** — target module phẳng
  `src/gsd/{config-loader,state-document,loop-resolver}.ts`. Guard flag: grep ra
  **10 file** (kể cả `phase-dag.ts`, `phase-sync.ts`, `workflow-tools.ts`), và 3 hàm
  cờ anh em (`isComplexityAssessorEnabled`…) gọi `isGsdNativeEnabled()` nội bộ →
  inline `true`, đừng xoá trắng.
- Part A slug-pid `phases/<pid>/` **đụng** model phase **số** mà `phase-sync.ts`/
  `phase-dag.ts` hard-assume (`padStart(2,"0")`, `phaseNumber`). Phải hoà giải:
  giữ ROADMAP số cho phase-sync, milestone/phase mới là **index chồng lên**, KHÔNG
  reroute `phase add` sang slug.

### MVP đã thu gọn (ship sprint này) — phần còn lại DEFER
**Ship:** Part A core + fold `.planning` (giữ `.muonroi-flow/`) + migration net-new
+ Resume Digest có nội dung + `research.md`/`context.md` first-class + `/ideal
resume|status|review`. Ghi `sprints/<n>-outcome.json` bằng `firePhaseOutcome` **đã
có**. → giải đúng nỗi đau resume-mù.
**Defer milestone sau:** Part B (SDK removal, sprint riêng + contract test), Part C
(chỉ per-stance-once, không per-turn), Part D (cross-repo, intra-session).
**Cắt/viết-lại:** Part E (làm provider adapter trước, hoặc bỏ).

---

## REV-3 — Sửa sau vòng council THẬT (TUI /council, panel deepseek-v4-flash × grok-composer-2.5-fast, leader glm-5.2)

> Drive TUI thật ở council mode (session `ffa43e994705`, 3 round, ~$0.10, panel
> "Plan Adversary" × "Code-Reality Auditor" đọc code bằng read_file/grep). Tôi tự
> verify 3/3 line-cite → chính xác. Council **xác nhận** REV-2 và thêm 2 điểm.

### REV-3 Kill A (MỚI — REV-2 bỏ sót) — Doc tự mâu thuẫn: REV-2 chưa merge vào body
REV-2 là khối *prepend* nhưng **body §3.3 cũ vẫn nói "xoá cờ + dep ngay"**, mâu
thuẫn REV-2 Kill #7 ("giữ 1 release"). Verdict council: *"implementer theo body
(xoá native) còn QA theo REV-2 (giữ native) → cùng sprint 2 thiết kế → rollback."*
→ **Đã sửa:** §3.3 + row rủi ro + mục 3.2 nay ghi rõ **loại bỏ 2 bước** (P3 giữ
cờ+dep rollback; release sau mới gỡ). Nguyên tắc mới: **mọi Kill của REV-2 phải
được reconcile TRỰC TIẾP vào body plan trước khi giao implementation**, không để
tồn tại song song "prepend đè body".

### REV-3 Kill B (sắc hơn REV-2) — `/ideal` là product mode nên phase-sync BỎ QUA hoàn toàn
`src/gsd/phase-sync.ts:164-166` (verified): `if (readWorkflowKind(cwd)==="product")
return {skipped:true, skipReason:"product"}`. `/ideal` = product → **phase-sync
numeric không chạy**; phase thật do `dispatchPhaseAdd` (`gsd-dispatch.ts:190-193`,
verified) tạo `.planning/phases/<NN>-slug` **qua subprocess GSD**. Hệ quả kép:
- Part A "reconcile với phase-sync numeric" là **moot cho /ideal** — không có
  phase-machinery in-process nào để hoà; hierarchy phải dựng MỚI.
- Part B đang gỡ chính subprocess `.planning/phases` mà Part A cần → **vòng phụ
  thuộc**: không thể vừa gỡ nền phase vừa xây hierarchy trên nó cùng sprint.
→ **Chốt scope (theo council):** Part A MVP **chỉ**: (1) fold `.planning/phases` +
`.muonroi-flow`, (2) sửa `phase-sync.ts` đọc từ layout mới, (3) **DỜI** hierarchy
milestone/phase-mới **và** `/api/workflow-event` **RA KHỎI MVP** cho tới khi có
module nền thật (`milestone-store`/`phase-store`) — hiện `migration.ts:56-58`
(verified) chứng minh code chỉ biết `.muonroi-flow/` + subprocess GSD.

### REV-3 xác nhận lại (council độc lập tái lập REV-2)
- `/api/workflow-event` không tồn tại; `council-bridge.ts:24` (verified) recall chỉ
  `["experience-behavioral","experience-principles"]` → workflow_* không được
  search (khớp Kill #3). `phase-outcome.ts` không phát workflow-event (khớp).
- `loop-driver.ts` giả định phase outcome có dữ liệu; `council-manager.ts` không có
  subscriber workflow-event → EE Part C/D vẫn là net-new, giữ nguyên DEFER.

### 3 việc bắt buộc TRƯỚC sprint-2 (council chốt, đã áp vào plan)
1. Hợp nhất toàn bộ Kill REV-2 vào body (Kill A) — **done** cho Kill #7; cần rà nốt
   Kill #1–#6 xem body còn chỗ nào nói ngược.
2. Viết lại Part A đúng scope MVP (Kill B) — fold + sửa phase-sync, dời hierarchy/EE.
3. Không giao implementation khi doc còn 2 giọng (prepend vs body).

**Lỗi hạ tầng ghi nhận (không phải nội dung):** leader `glm-5.2` trên opencode-go
trả `Decision: evaluation unavailable` → outcome 0/4 criteria là **false-negative
của evaluator**, không phải debate rỗng (debate có evidence table file:line thật).
Nên cân nhắc leader council mặc định là model eval-ổn (không phải glm trên
opencode-go) — cải thiện Part E/council-config sau.

---

## 0. Triết lý cốt lõi (north star)

> **"Tôi không train, không fine-tune model. Nhưng khi model chạy trong
> muonroi-cli, nó trở thành *model của tôi* — nhờ EE workflow mạnh +
> muonroi-docs."**

Cơ chế biến base-model bất kỳ thành "model của tôi" = **grounding bằng 2 nguồn
sự thật**, tiêm vào **từng lượt suy nghĩ của từng agent** (không phải một pipe
pre/post):

| Nguồn sự thật | Là gì | Vai trò trong debate |
|---|---|---|
| **#1 — EE (Experience Engine)** | Kinh nghiệm thực thi tích luỹ xuyên run (lesson, gotcha, outcome, mistake, decision, developer-profile) | Recall vào system/context của **mỗi agent, mỗi round**; và **ghi lại** kinh nghiệm sinh ra trong lúc debate/execute |
| **#2 — muonroi-docs** | Tri thức curated, authoritative (BB recipes, rule engine, platform setup) | Nguồn tra cứu chuẩn cho stance Researcher/Architect; đã là "authoritative source" trong PIL |

Khác biệt với GSD nguyên bản: GSD = playbook tĩnh, stateless. muonroi-cli =
**hai nguồn sự thật sống** → càng dùng càng "thành model của bạn", không cần đụng
trọng số.

---

## 1. Bốn mục tiêu (đã chốt với owner)

| # | Mục tiêu | Quyết định |
|---|---|---|
| **A** | State phân cấp `milestone → phase → task/research/context/sprints` | Full hierarchy |
| **B** | Gỡ hết `@opengsd/gsd-core`, council workflow native 100% | Không SDK ngoài |
| **C** | EE + muonroi-docs = 2 nguồn sự thật tiêm vào **mỗi lượt debate** | Bắt buộc |
| **D** | **Nâng cấp chính EE** (repo `experience-engine`): bắt kinh nghiệm thực thi, kết hợp write+recall trong workflow | Bắt buộc — **cross-repo** |
| **Loc** | Hợp nhất `.muonroi-flow/` + `.planning/` → `.muonroi-cli/` | Cần migrate data cũ |
| **Delivery** | Plan → duyệt → implement + test | (tài liệu này) |

**Phạm vi 2 repo:**
- `/mnt/data/Personal/Core/muonroi-cli` — Part A, B, C (wiring), Loc.
- `/mnt/data/Personal/Core/experience-engine` — Part D (nâng cấp EE server/schema).

---

## 1. Cây thư mục đích — `.muonroi-cli/` (project-level)

```
.muonroi-cli/
├── state.md                     # con trỏ toàn cục: activeMilestone, activeRun, activePhase
├── config.json                  # (từ .planning/config.json) — model bindings, personas
├── roadmap.md                   # roadmap xuyên milestone (index)
├── backlog.md
├── decisions.md                 # decisions.lock toàn cục
├── who-am-i.md                  # snapshot developer profile từ EE (C)
├── milestones/
│   └── <mid>/                   # vd: m01-native-workflow
│       ├── milestone.md          # goal, status, createdAt, phases[], successCriteria[]
│       ├── roadmap.md            # phase breakdown của milestone này
│       └── phases/
│           └── <pid>/            # vd: p01-remove-sdk
│               ├── phase.md       # goal, status, runId, sprints[], DoD criteria
│               ├── research.md    # ← FIRST-CLASS: debate summary + findings + EE recall
│               ├── context.md     # ← FIRST-CLASS: prior-run digest + project context
│               ├── tasks.json     # task units (gắn phaseId, sprintN)
│               ├── decisions.md    # decisions phát sinh trong phase
│               └── sprints/
│                   ├── <n>-plan.md
│                   ├── <n>-verify.md
│                   └── <n>-outcome.json   # EE phase-outcome payload (C)
├── runs/<runId>/                # instance thực thi (crash-safe), trỏ milestone+phase
│   ├── manifest.md               # trạng thái run: running|halted|shipped, phaseRef
│   ├── state.md                  # Resume Digest (PHẢI có nội dung) + Experience Snapshot
│   └── iterations.md
└── history/                     # transcript đã ship, phục vụ review
    └── <ts>.{json,md}
```

Nguyên tắc: **milestone/phase = knowledge bền vững** (bạn xem lại, resume); **run =
lát cắt thực thi** (có thể nhiều run cho một phase khi retry/crash). `run.manifest`
trỏ tới `{milestoneId, phaseId}` để mọi thứ nối lại được.

---

## 2. Part A — State hierarchy (native TS)

### 2.1 Module mới
| Module | Trách nhiệm |
|---|---|
| `src/flow/paths.ts` | Hằng số `CLI_DIR_NAME = ".muonroi-cli"`, resolver `milestoneDir/phaseDir/runDir`. **Nguồn chân lý duy nhất** cho path. |
| `src/flow/milestone-store.ts` | CRUD `milestone.md` (create/load/list/complete), sinh `<mid>` slug. |
| `src/flow/phase-store.ts` | CRUD `phase.md`, `research.md`, `context.md`, `tasks.json`, `sprints/`. |
| `src/flow/state-pointer.ts` | Đọc/ghi con trỏ `activeMilestone/activePhase/activeRun` ở top `state.md`. |
| `src/flow/schema.ts` | Types: `Milestone`, `Phase`, `SprintRecord`, `ResumeDigest`, `RunManifest`. |

### 2.2 Schema types (nháp)
```ts
interface Milestone { id; title; goal; status: "active"|"done"|"archived";
  createdAt; successCriteria: string[]; phaseIds: string[] }
interface Phase { id; milestoneId; title; goal; status: "planned"|"researching"
  |"planning"|"executing"|"verifying"|"done"|"halted"; runId?; sprintCount;
  doD: string[]; researchRef; contextRef }
interface ResumeDigest { phaseRef; lastStage; nextAction; openQuestions: string[];
  eeSnapshot: string /* từ EE */ }
```

### 2.3 File đụng tới (rewire path + ghi first-class)
- `src/flow/scaffold.ts` → đổi `FLOW_DIR_NAME` `.muonroi-flow` **→** `.muonroi-cli`; scaffold cây mới. Giữ export cũ như alias `@deprecated`.
- `src/flow/run-manager.ts` → run trỏ milestone/phase; tách `research.md`/`context.md` khỏi `delegations.md`.
- `src/product-loop/loop-driver.ts`:
  - stage `research` (L701-707): ghi `research.md` first-class (thay vì section trong `delegations.md`).
  - stage `scoping`: sinh/ghi `milestone.md` + `phase.md` từ `ProductSpec`; `context.md` từ debate context.
  - **Ghi Resume Digest có nội dung** (hiện `state.md` để trống — nguyên nhân resume mù).
- `src/product-loop/sprint-runner.ts` → ghi `sprints/<n>-plan.md|verify.md|outcome.json` vào phase dir.
- `src/product-loop/typed-artifacts.ts` → `tasks.json` chuyển sang phase dir, thêm `phaseId`.
- Call sites hard-code path phải qua `paths.ts`: `orchestrator.ts:2318,3099`, `pil/layer5-context.ts:61-64`, `ui/slash/{compact,clear,expand,status}.ts`, `flow/scaffold-checkpoint.ts`, `maintain/task-runner.ts:34`.

---

## 3. Part B — Gỡ SDK ngoài (`@opengsd/gsd-core`)

### 3.1 Bề mặt còn phụ thuộc (từ scan)
9 hàm trong `src/gsd/gsd-dispatch.ts` shell ra `gsd-tools.cjs`:

| Subcommand | Việc | Native reimpl |
|---|---|---|
| `loop render-hooks <point>` | resolve Capability Registry hooks | dùng `native/orchestrator.ts` (đã có từ sprint 1) |
| `init progress` | milestone/phase progress JSON | đọc `milestones/*/phase.md` → tổng hợp |
| `config-ensure-section` | bootstrap `config.json` | `native/config-loader.ts` + writer |
| `state update <field> <value>` | ghi STATE.md frontmatter | `native/state-document.ts` (đã có `stateReplaceField`) |
| `state json` | snapshot frontmatter | `native/state-document.ts` (`stateExtractField`) |
| `phase add <desc>` | tạo `phases/<NN>-<slug>/` | `phase-store.ts` (Part A) |
| `phase complete <N>` | đánh dấu phase done | `phase-store.ts` |
| `roadmap update-plan-progress <N>` | sync checkbox ROADMAP | `roadmap-writer.ts` mới |
| `roadmap analyze` | parse ROADMAP + disk status | `roadmap-writer.ts` mới |

### 3.2 Hành động
- Tạo `src/gsd/native/roadmap.ts` + `src/gsd/native/progress.ts` cho 4 hàm roadmap/progress.
- Viết lại 9 hàm trong `gsd-dispatch.ts` gọi native, **bỏ** `resolveGsdToolsBin`, `runGsdTools`, `execFileSync`, `createRequire`.
- **Bước 2 mới xoá** `@opengsd/gsd-core` khỏi `package.json` (gỡ re-export `gsd/index.ts:26-27`, facade `@deprecated GsdHostAdapter`). P3 giữ dep để rollback (xem 3.3).
- **Contract test** (theo rule sprint 1): mỗi hàm native cho output tương đương subprocess trên fixture `.planning/` mẫu → chống regress.
- Cập nhật text `product-workspace.ts:39` bỏ nhắc `@opengsd/gsd-core`.

### 3.3 Điểm phải cẩn thận
- `native/config-loader.ts` hiện đọc `.planning/config.json` → đổi sang `.muonroi-cli/config.json` (đồng bộ Part A/Loc), có fallback đọc `.planning` cũ khi migrate.
- `MUONROI_GSD_NATIVE=0` (legacy) hiện tắt toàn bộ gsd_* tools. **QUYẾT ĐỊNH (đã reconcile theo REV-2 Kill #7 — GHI ĐÈ quyết định "bỏ ngay" trước đó):** loại bỏ theo **2 bước, không cùng P3**:
  - **Bước 1 (P3):** native-hoá 9 hàm dispatch + contract test; **GIỮ** dep `@opengsd/gsd-core` và cờ `MUONROI_GSD_NATIVE` làm fallback/rollback. Cờ ON = native (mặc định).
  - **Bước 2 (release sau, sau khi native soak qua contract test + dùng thật):** mới gỡ `isGsdNativeEnabled()` + mọi guard (`flags.ts`, `message-processor.ts`, `layer3/layer4`, `phase-runner.ts`, `product-loop/index.ts` — **lưu ý `tool-engine.ts` KHÔNG có guard này**, council round-1 xác nhận) và xoá dep khỏi `package.json`.
  - Council round-2 (TUI thật) chỉ ra: body cũ nói "xoá ngay" mâu thuẫn REV-2 → nếu implementer theo body (xoá native) còn QA theo REV-2 (giữ native) thì cùng sprint chạy 2 thiết kế → rollback. Nay đã đồng bộ.

---

## 4. Part C — 2 nguồn sự thật tiêm vào MỖI lượt debate (muonroi-cli side)

Hiện EE chỉ chạy như **pipe pre/post** (recall seed 1 lần trước debate, extract 1
lần sau). Nâng thành **grounding per-turn**: mỗi lượt nói của mỗi agent được bọc
bởi 2 nguồn sự thật.

### 4.1 Điểm tiêm (per debate turn)
Trong `src/council/debate.ts` (`buildDiscussPrompt` open/respond/followup) và
`council-manager.buildDiscussPrompt`, trước mỗi lượt gọi model, chèn khối:

```
## Nguồn sự thật #1 — Kinh nghiệm (EE recall cho stance này)
{ council-bridge.queryExperience(topic + stanceLens) → top-k lesson [id col] }

## Nguồn sự thật #2 — muonroi-docs (nếu topic thuộc BB/rule-engine/platform)
{ mcp_muonroi-docs__* kết quả authoritative, đã có smart-filter giữ verbatim }
```

- Recall **theo stance**: Researcher recall lesson kỹ thuật, Skeptic recall các
  mistake/gotcha đã gặp, Architect recall decision cũ. → mỗi agent "nhớ" khác nhau.
- Docs **ROI-gated**: chỉ fetch khi PIL cờ topic là ecosystem (đã có
  `shouldApplyEcosystemBias`, `fetchBBContext`), tránh tốn token cho topic generic.

### 4.2 Ghi kinh nghiệm ngay trong lúc thực thi (không chỉ cuối phase)
| Thời điểm | Ghi gì vào EE | API |
|---|---|---|
| Sau mỗi round debate | Điểm converge/dispute + evidence mới | `POST /api/posttool`-style hoặc kênh mới (Part D) |
| Sau mỗi sprint | outcome pass/fail/score + failedCondition | `phase-outcome.firePhaseOutcome` → `/api/phase-outcome` (đã có) |
| Khi verify FAIL lặp | mistake signature | `ee/mistake-detector.ts` → kênh mistake (Part D) |
| Khi chốt decision | decision + lý do | kênh decision (Part D) |

### 4.3 Nhúng EE vào từng tầng state (như cũ, giữ nguyên)
| Tầng state | EE primitive | Giá trị thêm |
|---|---|---|
| `context.md` | `cross-run-memory.buildPriorContext()` | Phase mới nạp digest run trước |
| `research.md` | `council-bridge.queryExperience()` | Recall trước debate (seed) |
| `sprints/<n>-outcome.json` | `firePhaseOutcome()` | Sprint đẩy kết quả vào brain |
| Resume Digest | `recall-ledger` + `phase-tracker` | Resume kèm việc dở + lesson |
| `who-am-i.md` | `ee/who-am-i.ts` | Workflow theo profile dev |
| Review | `composeRunTranscript()` + outcomes | Xem lại có cấu trúc |

Kết phase: `extractRunToEE()` đẩy transcript → EE evolve thành principle → vòng
học khép kín.

---

## 5. Part D — Nâng cấp Experience Engine (repo `experience-engine`)

> Mục tiêu: EE hôm nay giỏi bắt **lesson tĩnh** (principle từ session cũ). Nâng để
> bắt **kinh nghiệm thực thi động** trong council workflow, và phục vụ recall
> per-turn ở mục 4. Đây là điểm biến base-model thành "model của tôi".

### 5.1 Hạ tầng đã có (tái dùng, đừng viết lại)
`POST /api/recall` (hybrid dense+BM25, RRF, `[id col]`), `/api/intercept`,
`/api/posttool`, `/api/extract`, `/api/evolve`, `/api/phase-outcome`,
`/api/feedback` (followed/ignored/noise), `/api/route-*`, tiers T0/T1/T2/self-QA.

### 5.2 Thêm — "experience kinds" cho workflow (collection/namespace mới)
| Kind | Ghi khi | Recall cho |
|---|---|---|
| `council-debate` | mỗi round: stance nào thắng lý lẽ, evidence quyết định | seed stance debate lần sau cùng topic |
| `sprint-execution` | mỗi sprint: plan→verify→score, file đụng, verify recipe | plan sprint tương tự |
| `decision` | khi council chốt (đã có `[Council Decision]` trong state) | tránh cãi lại quyết định cũ |
| `mistake` | verify FAIL lặp / oscillation (CB-2) | chặn lặp lỗi (guard mục 4.2) |

Triển khai: mở rộng `evolution.js upsertEntry` + collection list trong
`.experience/src/config.js`; **không** phá schema cũ (thêm namespace, không sửa
tier hiện có). Migration sparse-BM25 dùng lại `tools/migrate-sparse-bm25.js`.

### 5.3 Thêm — recall theo stance/role (server-side)
`POST /api/recall` nhận thêm `stance?`/`role?` để lọc/tăng trọng số collection
phù hợp (Skeptic→mistake, Architect→decision). Fallback: bỏ qua nếu không truyền
→ **không breaking**.

### 5.4 Thêm — write-during-execution endpoint
Kênh nhẹ `POST /api/workflow-event` (hoặc mở rộng `/api/phase-outcome`) nhận
`{kind, phaseRef, payload, sessionId}` để muonroi-cli ghi kinh nghiệm giữa chừng
(mục 4.2) mà không cần đợi extract cuối session. Fire-and-forget, offline-queue
(đã có `offline-queue.ts`) khi server unreachable.

### 5.5 Kết hợp write + recall (closed loop trong 1 phiên)
Trong cùng một run: ghi `sprint-execution` sprint 1 → sprint 2 recall được ngay
kinh nghiệm sprint 1 (không phải chờ evolve qua đêm). Cần EE cho phép recall
**entry chưa evolve** với confidence thấp hơn (gate riêng `intra-session`), để
kinh nghiệm nóng dùng được liền nhưng không nhiễm long-term principle cho tới khi
`/api/evolve` xác nhận.

### 5.6 File EE đụng tới (nháp)
- `.experience/src/config.js` — thêm collection `workflow_*`.
- `.experience/experience-core.js` / `server.js` — handler `/api/workflow-event`, tham số `stance` cho `handleRecall`.
- `src/evolution.js` — `upsertEntry` cho kind mới + gate `intra-session`.
- `tools/migrate-sparse-bm25.js` — chạy cho collection mới.
- muonroi-cli side: `src/ee/client.ts` + `council-bridge.ts` gọi API mới.

---

## 5b. Part E — Model có web-research native là BẮT BUỘC trong research phase

> Nguyên tắc owner: khâu research của council **phải** kết hợp web research thật,
> không chỉ đọc codebase. Web research phải đến từ **năng lực native của model**
> (Grok, OpenAI có browsing/web_search sẵn) — Tavily/MCP chỉ là **add-in, không
> đáng tin** nếu setup kém (hiện `web_search` trả `ERROR no_tavily_key` khi thiếu key).

### 5b.1 Hiện trạng (mong manh)
- `src/tools/research.ts` — builtin `web_search` = gọi Tavily API; không key → lỗi.
- `src/council/llm.ts:777-785` — chỉ cảnh báo "Research Gap" khi không có Tavily/MCP; **không** ưu tiên model tự search được.
- Catalog `CatalogModel` chưa có cờ đánh dấu model nào research online được.

### 5b.2 Thêm capability flag vào catalog — audit TOÀN BỘ catalog
Catalog hiện có **29 model / 5 provider** (`deepseek×2, openai×3, xai×2, zai×9,
opencode-go×13`) ở `src/models/catalog.json`, có thể serve remote qua
`MUONROI_CATALOG_URL`. Grok/OpenAI chỉ là **ví dụ** — phải audit từng model theo
năng lực thật, không hardcode theo provider.

`CatalogModel` (`src/models/catalog-client.ts:105`) + schema Zod (L133):
```ts
/** Model tự research online (native web-search/browsing/Live Search). Nguồn quyết định độ tin research online. */
native_web_research?: boolean;
/** (tuỳ chọn) cơ chế: "live-search" | "web-tool" | "browsing" | null — để chọn cách kích hoạt. */
web_research_kind?: string | null;
```

**Nguyên tắc điền flag (per-model, không per-provider):**
- Flag là **thuộc tính của catalog** (source of truth) — điền trong `catalog.json`
  và catalog service remote, để cập nhật không cần build lại CLI.
- Audit từng model trong 29 model: bật `true` **chỉ khi** model thực sự có web
  research native (xác nhận qua provider docs), kể cả trong cùng provider có model
  có/không (vd một biến thể `-mini` có thể không bật web tool).
- **Không suy diễn theo provider** — `xai`/`openai` không tự động = true cho mọi
  biến thể; `zai`/`opencode-go`/`deepseek` không tự động = false nếu thực tế có.
- Thiếu flag → coi như `false` **an toàn** (buộc fallback add-in + log degraded),
  không đoán bừa.
- Kèm test drift: cảnh báo khi catalog có model mới chưa gán `native_web_research`
  (buộc người thêm model phải quyết định giá trị).

### 5b.3 Research phase BẮT BUỘC dùng model web-research
Trong `council-manager.research()` và `loop-driver` research stage:
1. **Ưu tiên**: chọn participant/model có `native_web_research === true` cho lượt gather online. Nếu roleModels research không có → tự nâng cấp sang model web-capable (qua router `getRoutedModelByTier`).
2. **Fallback rõ ràng**: nếu KHÔNG có model web-native nào khả dụng → dùng Tavily/MCP như add-in **và** log cảnh báo hạ độ tin cậy vào `research.md` (`## Research Confidence: degraded — no native web model`).
3. **Không bao giờ** để research phase chạy "mù" (chỉ codebase) mà không đánh dấu gap.

### 5b.4 Kết hợp 3 nguồn trong research (thứ tự tin cậy)
```
1. muonroi-docs (authoritative)          ← nguồn sự thật #2
2. Model có native_web_research=true (bất kỳ trong catalog) ← BẮT BUỘC cho online facts
3. Codebase (bash/grep/read)             ← đã có
—— add-in (chỉ khi thiếu #2) ——
   Tavily / MCP browser                  ← không đáng tin, phải log degraded
```

### 5b.5 File đụng tới
- `src/models/catalog-client.ts` — thêm field + schema.
- Catalog data (nguồn catalog remote/local) — điền `native_web_research`.
- `src/council/council-manager.ts` `research()` — chọn model web-capable + fallback log.
- `src/product-loop/loop-driver.ts` research stage — gắn participant web-capable cho stance Researcher.
- `src/council/llm.ts` — Research Gap warning nâng thành "chọn model web-native" thay vì chỉ cảnh báo Tavily.

---

## 6. Data migration (`.muonroi-flow` + `.planning` → `.muonroi-cli`)

`src/flow/migration.ts` (đã tồn tại — mở rộng):
1. Nếu có `.muonroi-cli/` → skip (idempotent).
2. Nếu có `.muonroi-flow/` cũ: bọc mỗi `runs/<rid>` thành một phase mặc định dưới `milestones/m00-legacy/phases/p00-<rid>/`; map `delegations.md#Research*` → `research.md`.
3. Nếu có `.planning/`: copy `config.json`, `ROADMAP.md`, `STATE.md`, `phases/*` vào cây mới.
4. Ghi `.muonroi-cli/.migrated-from` để audit; **không xoá** bản cũ (an toàn), chỉ ngừng ghi.
5. Version hoá qua `state.md` field `schemaVersion` để migrate tương lai.

---

## 7. Resume & Review UX (đích cuối)

- `/ideal resume` → đọc `state.md` con trỏ → `phase.md` + Resume Digest (giờ có nội
  dung) + EE recall → tiếp đúng stage dang dở.
- `/ideal status` → cây milestone/phase + % + sprint scores (thay `.planning` cũ ở `ui/slash/status.ts:18`).
- `/ideal review [<mid|pid|runId>]` (mới) → render `composeRunTranscript` + outcomes.
- `/ideal milestones` / `/ideal phases` (mới) → liệt kê để nhảy tới.

---

## 8. Action items theo thứ tự (7 nhóm, xuyên 2 repo)

**P1 — Nền tảng path/schema (không đổi hành vi)** · _muonroi-cli_
1. `flow/paths.ts` + `flow/schema.ts`.
2. Rewire mọi hard-code `.muonroi-flow`/`.planning` → `paths.ts`.

**P2 — Store hierarchy** · _muonroi-cli_
3. `milestone-store.ts`, `phase-store.ts`, `state-pointer.ts`.
4. `scaffold.ts` cây mới + alias deprecated.

**P3 — Native SDK removal** · _muonroi-cli_
5. `gsd/native/roadmap.ts` + `progress.ts`.
6. Viết lại 9 hàm `gsd-dispatch.ts` → native; xoá subprocess.
7. Contract test tương đương; gỡ dep `package.json`; gỡ facade.

**P4 — Loop wiring** · _muonroi-cli_
8. `loop-driver.ts`: research.md/context.md/milestone.md/phase.md first-class + Resume Digest.
9. `sprint-runner.ts`: sprints/ artifacts + outcome.json.
10. `typed-artifacts.ts`: tasks.json về phase dir.

**P5 — EE upgrade (server/schema)** · _experience-engine_ (làm SONG SONG P1–P4)
11. Thêm collection `workflow_{debate,sprint,decision,mistake}` (`config.js` + `evolution.js`), migrate sparse-BM25.
12. `POST /api/workflow-event` (write-during-execution) + gate `intra-session` cho recall entry chưa evolve.
13. `handleRecall` nhận `stance?`/`role?` (non-breaking).

**P6 — EE wiring (2 nguồn sự thật per-turn)** · _muonroi-cli_
14. **Per-turn injection** trong `council/debate.ts` + `council-manager.buildDiscussPrompt`: khối "Nguồn sự thật #1 EE recall theo stance" + "#2 muonroi-docs" (ROI-gated).
15. Ghi giữa chừng: round-outcome + sprint-outcome + mistake + decision → `/api/workflow-event`.
16. Tầng state: context.md ← buildPriorContext; research.md ← queryExperience; outcome.json ← firePhaseOutcome; Resume Digest ← recall-ledger; who-am-i.md; mistake guard.

**P6b — Web-research native bắt buộc (Part E)** · _muonroi-cli_
17. `catalog-client.ts`: thêm `native_web_research` + schema; điền data (Grok/OpenAI = true).
18. `council-manager.research()` + loop-driver: ưu tiên model web-native cho stance Researcher; fallback Tavily/MCP + log `Research Confidence: degraded`.
19. `council/llm.ts`: Research Gap → "chọn model web-native" thay vì chỉ cảnh báo Tavily.

**P7 — Migration + UX + E2E** · _muonroi-cli_
20. `migration.ts` mở rộng (mục 6).
21. `/ideal resume|status|review|milestones` (mục 7).
22. E2E: start → debate (per-turn EE+docs+web-native) → sprint → ghi/recall intra-session → crash → resume → review; và migrate từ `.muonroi-flow` cũ.

---

## 9. Rủi ro & giảm thiểu

| Rủi ro | Giảm thiểu |
|---|---|
| Đổi path phá caller ẩn | `paths.ts` là điểm duy nhất + grep-gate CI cấm literal `.muonroi-flow`/`.planning` |
| Gỡ SDK làm lệch hành vi | Contract test tương đương trên fixture trước khi xoá dep |
| Data cũ của user mất | Migration idempotent, **không xoá** bản cũ, ghi `.migrated-from` |
| Cờ `MUONROI_GSD_NATIVE=0` treo | **Loại bỏ 2 bước** (Kill #7): P3 giữ cờ+dep làm rollback; release sau mới gỡ guard `isGsdNativeEnabled()` + xoá dep (mục 3.3) |
| EE offline/timeout chặn workflow | Mọi call EE fire-and-forget + `offline-queue` (đã có) — workflow không bao giờ block chờ EE |
| Per-turn recall làm chậm/đắt debate | Recall cache theo (stance, topic-hash) trong 1 debate; docs ROI-gated; giới hạn top-k |
| Kinh nghiệm nóng (intra-session) nhiễm principle dài hạn | Gate `intra-session` riêng, confidence thấp, chỉ promote khi `/api/evolve` xác nhận |
| Đổi schema EE phá client cũ | Chỉ THÊM collection/param optional — không sửa tier/endpoint hiện có |
| 2 repo lệch version | Feature-flag `EXPERIENCE_WORKFLOW_KINDS`; muonroi-cli degrade khi EE chưa có endpoint mới |
| Nhánh migration đang mở | muonroi-cli: `feat/native-state-ee`; EE: `feat/workflow-experience`; rebase lên `develop` |

---

## 10. Acceptance criteria

**Part B — native 100%**
- [ ] `grep -r "@opengsd/gsd-core" src/` = 0 (trừ comment lịch sử); `package.json` sạch dep.
- [ ] Contract test 9 hàm native pass; suite xanh.

**Part A + Loc — hierarchy**
- [ ] `grep -rE "\.muonroi-flow|\"\.planning\"" src/` = 0 (mọi path qua `paths.ts`).
- [ ] `/ideal "<idea>"` tạo đúng `.muonroi-cli/milestones/*/phases/*/` với research.md + context.md + tasks.json có nội dung.
- [ ] `state.md` Resume Digest KHÔNG rỗng sau research; `/ideal resume` tiếp đúng stage.
- [ ] `/ideal review <id>` render transcript + sprint scores; `.muonroi-flow/` cũ migrate không mất data.

**Part C + D — 2 nguồn sự thật + EE upgrade**
- [ ] Mỗi lượt debate có khối "Nguồn sự thật #1 EE" (recall theo stance) và, khi ecosystem, "#2 muonroi-docs" — kiểm bằng log debate.
- [ ] EE có collection `workflow_*`; `POST /api/workflow-event` ghi được round/sprint/mistake/decision.
- [ ] **Closed loop nội phiên**: sprint 2 recall được kinh nghiệm sprint 1 trong CÙNG run (test E2E).
- [ ] Recall nhận `stance` và trả tập khác nhau cho Skeptic vs Architect.
- [ ] EE offline → workflow vẫn chạy hết (degrade sạch), event vào offline-queue.

**Part E — web-research native bắt buộc**
- [ ] `CatalogModel.native_web_research` tồn tại; **toàn bộ 29 model** được gán giá trị (true/false có chủ đích, không bỏ trống).
- [ ] Research phase quét catalog, chọn model có `native_web_research===true` cho stance Researcher; khi không có model nào → `research.md` ghi `Research Confidence: degraded`.
- [ ] Test drift: thêm model mới vào catalog mà thiếu flag → CI cảnh báo.
- [ ] Không có run research nào chạy chỉ-codebase mà không đánh dấu gap.

---

_Chờ owner duyệt PLAN này trước khi implement P1. Hai nhánh: muonroi-cli
`feat/native-state-ee` + experience-engine `feat/workflow-experience`._
