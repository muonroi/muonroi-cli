/**
 * docs/semantic-workbench/slice1-self-verify.ts
 *
 * SUPERSEDED — the Slice 1 self-verify harness is now a wired vitest spec that
 * runs in CI (this standalone script used the pre-spec `readiness`/`fallbackRecommended`
 * contract and was never wired into `vitest`/`package.json`):
 *
 *   src/lsp/__tests__/slice1-self-verify.test.ts
 *
 * It proves the lsp-before-grep golden path against the real manager contract
 * (SLICE1-BUILD-NOTE.md): LSP `ok` → no grep fallback; LSP `partial`/`unavailable`
 * → grep fallback allowed; and the ≤500 token-budget cap. Run it with:
 *
 *   bunx vitest run src/lsp/__tests__/slice1-self-verify.test.ts
 *
 * This file is kept only as a pointer so links to the old path do not 404.
 */

export {};
