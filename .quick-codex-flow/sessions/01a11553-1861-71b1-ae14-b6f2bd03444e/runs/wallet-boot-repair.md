# Undefined wallet callback boot repair

## Requirement / Route
- User supplied a runtime screenshot: ReferenceError applyWalletSettings is not defined, useAppLogic dist/src/ui/use-app-logic.js:7735.
- Route: qc-flow, because wallet persistence semantics and real React mount verification required source research.
- Scope: use-app-logic.tsx three stale callback references; a focused mounted-TUI regression; local build and QA artifacts. Preserve PIL repair and all unrelated WIP.
- Main-session coordination analysis is complete in SESSION-COORDINATION-AUDIT.md; no coordination production edits were made.

## Evidence / Resolved Gray Areas
- use-app-logic.tsx has @ts-nocheck, so tsc does not reject the missing identifier.
- A dependency array evaluates applyWalletSettings during every render, before /wallet is opened. No definition exists in source or rebuilt output.
- constants.ts:184 WALLET_ROWS are all readonly; openWalletPicker resets in-memory walletSettings and comments that Stripe billing is pending. No payment persistence or execution is authorized by this repair.
- Existing native smoke reaches idle with final frame nodes=[]; this is insufficient to prove React mounted. The focused regression requires id=composer, nonempty semantic nodes, registered input and a live child process.
- Minimal repair: use the already-defined React state setter setWalletSettings at the two obsolete update sites and dependency array, without adding a new payment API.
- All gray areas for this scope resolved; exact code and runtime screenshot support the repair.

## Verified Plan
- P1/W1: add mounted-TUI regression, record pre-fix failure; replace exactly three stale references; rebuild/typecheck; run mounted TUI test and native selfverify tool.
- P2/W1: run sub-session coordination tests while resuming read-only analysis; do not repeat the entire 14-minute suite absent a new change that warrants it. No push or commit.
- Plan verdict PASS. Single-agent execution. User's image authorizes restoring the reported broken startup.
- Current gate done; P1/W1 and P2/W1 complete. Verification scope narrowed to startup after broader harness navigation attempts failed to establish reliable keyboard interaction; no wallet open/close success is claimed.

## Verification Ledger
- Before fix: the mounted-composer wait times out after 15 seconds; the supplied screenshot identifies the undefined render-time dependency.
- Production change: exactly three applyWalletSettings references become the existing setWalletSettings setter (two update sites and dependency array). No payment API or persistence was added.
- After fix: tests/harness/wallet-boot.spec.ts passes 1/1 in 2.69s, requiring the actual composer, semantic nodes, input-ready event and a live process. Evidence: wallet-boot-final.log.
- Build and typecheck pass; wallet-rebuild.log records the build. Rebuilt JS uses setWalletSettings and contains no applyWalletSettings reference.
- Native local selfverify run ff192c19-e3d9-48cb-9f10-8faef9722a92: 1 passed / 0 failed / 0 inconclusive. Full report: wallet-local-selfverify-result.json. Native smoke alone is limited to boot/idle; the mounted regression supplies React proof.
- Related coordination/budget/mutex tests: 110 + 52 passed across 13 files; see session-coordination-tests.log and session-mutex-tests.log.
- Broader /wallet keyboard navigation attempts did not verify wallet open/close: early Enter selected a stale /exit item; waiting for the wallet slash item timed out; programmatic typing did not establish the expected semantic value. The exact bridge/hook cause remains untraced. These experiments are not represented as passing coverage or as the cause of the startup crash.
- The earlier full suite remains 8728 passed / 5 failed. It was not repeated after this three-reference startup repair. Four failures reproduced on unchanged HEAD; one foreign-feedback EE integration assertion passes in isolation. No full-suite-green claim and no push/commit.
- Source/worktree changes remain local; restart the CLI to load the rebuilt files. Unrelated WIP is preserved.
