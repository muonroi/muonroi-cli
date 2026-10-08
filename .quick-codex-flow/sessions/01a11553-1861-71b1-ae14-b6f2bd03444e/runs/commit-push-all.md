# Commit and push all workspace changes

Workflow: qc-flow, single agent, auto. User explicitly authorizes commit and push all changes.
Goal: commit the complete non-ignored workspace change set and push develop to origin with mandatory checks passing.
Gate: research closed; plan-check passed; wave1 staging and hooks.
Evidence: git status contains fixes across orchestration/PIL, catalog/API, auth/UI and analysis/workflow artifacts. Current branch develop, origin github.com/muonroi/muonroi-cli; fetch develop succeeded. Staged _query-usage.js also has unstaged changes, so stage final working version. Secret scan of all changed/non-ignored untracked files found zero credential/private-key pattern matches.
Protected: actual user credentials, unrelated content preserved and included as requested; no force push, no reset, no npm publication or redeploy. Existing local commits will accompany new commit if ahead.
Gray areas: resolved; configured unit runner is package test script bunx vitest run; bare bun test is not the configured suite. Real hooks contain secret scan + lint-staged, then semantic lint + self-verify + compile smoke. Artifact/log files ignored by git remain local; do not force-add them.
Plan: stage all -> run secret scan/lint-staged and resolve errors -> full configured suite zero failed -> catalog API Python tests/build + mounted changed flows/native selfverify -> finalize commit message with test/session evidence and commit with hooks -> verify any hook changes -> push with all hooks -> confirm remote SHA and clean working tree.
Plan-check: checks cover full staged source, UI runtime, API contracts, import graph and actual remote ref. No bypass of hooks/test gate. Test failures must be repaired before push.
Resume: execute wave1. Any semantic code fix requires rerunning applicable/full tests before push.
