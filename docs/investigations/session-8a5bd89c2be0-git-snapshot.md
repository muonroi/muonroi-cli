# Git snapshot refusal in session 8a5bd89c2be0

The recorded failure does not establish a requirement to stage or commit PLAN.md.

- Live debug.log:7144 records `Review dispatch refused` with `Source snapshot: git checkout could not be enumerated.` at2026-11-02T09:24:47.836Z. The old wrapper discarded the native Git error in the returned refusal; historical PATH/environment/timeout/corruption cause cannot be determined from that line.
- `git rev-parse --show-toplevel` currently succeeds for `D:/sources/CompanyLibs/tcis-libraries`. PLAN.md is Git-ignored. Native plan binding separately hashes its exact file contents and context, so Git index membership is not required for review provenance.
- Two direct Bun1.3.13 calls to the actual sourceFingerprint function succeeded with fingerprint `f234c741f5f2795f86ef6fd773e920a1df09950ef1e383882145b0e5bed71cce`. Index SHA before/after remained `7549b0d1f10cb7ec6f523f626e526c826845ecbac5b1dc4b8382a2220c1e2134`; no staging, commit, Git configuration or consumer environment change was performed. PLAN remains SHA `51a1ab4452838d799b5fff4126d65311893e6493c713252a8ca96e532bffc384`.

The CLI diagnostic fix preserves the original command, cwd, native status/code/signal and bounded redacted stderr in a checkout refusal, and persists it at warning level. A broken checkout still fails closed. A real nongit workspace retains its existing bounded filesystem fallback. The fix does not claim to repair the unknown historical process failure.

Verification:123 tests across Git-probe, independent-review and async-plan-review suites passed; build/typecheck succeeded. Native selfverify smoke-boot `7ff7a125-0a27-42b6-a7a2-7f25c978c6b4` passed1/1. Owned Git fixtures prove that ordinary untracked source affects fingerprint and ignored PLAN affects the explicit planning-input binding without index mutation. An invalid Git marker reproduces native status128/stderr loss before the fix and preserves those details afterward.

No paid revalidation or gate completion was invoked. Reopen the CLI to load the improved diagnostic; if its process still cannot run Git, inspect the newly returned native error instead of staging the plan or clearing state. Current successful probes do not prove admission of the live session.
