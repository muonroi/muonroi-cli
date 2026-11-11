# Proactive owner instructions refused by empty replyTo

Read-only SQLite inspection of session4edc02516a92 found two actual delegation_send calls to steady-emerald-owl:

- call_e3633e3639de4848a381b71a
- call_6106f05bbb4a46c6991b7427

Both supplied `replyTo:""` with a proactive corpus-pattern correction. Both returned `message_refused: message reply correlation is missing, stale or expired.` The native tool schema made replyTo optional, but the host selected reply mode whenever replyTo was not undefined. This establishes an empty-option handling defect; it does not establish that proactive worker instructions require a question.

The host now treats an empty/whitespace optional replyTo as absent, queues kind=instruction and preserves nonempty correlation IDs exactly. Receipts state kind explicitly. Headless execution does not wait for a question on blank instructions. A genuine reply still needs the exact live worker question messageId; foreign ownership, stale/expired correlation, terminal/council jobs, legacy receivers, conflicting retries and permission changes remain refused.

Native descriptions and the main operating contract explicitly direct `delegation_send({id,message})` for proactive corrections, with no prior question required. A correlation error explains that distinction. Instructions are injected at the next safe model step; they cannot interrupt an in-flight provider request. They do not answer a pending question or renew its deadline.

Two empty-option tests failed before the fix. Final combined regression coverage passed82 tests/7files, including actual mock-SDK prompt delivery of the correction and headless blank-instruction tests. This investigation did not send a correction to the user's live worker, alter its mailbox, or change the consumer PLAN/gate. Running hosts need a fresh process to load rebuilt code; existing worker results still need main's evidence adjudication.

Final build/typecheck passed; installed-global JS matches the workspace output. Rebuilt workspace native selfverify run f70a2ce7-c9bc-4974-b159-212afeefcab9 passed smoke-boot1/1. This boot check is separate from the owned-fixture SDK delivery test and does not establish delivery to an existing live worker.
