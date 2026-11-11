# csharp-ls visible console investigation

## Confirmed runtime observations

- Win32_Process initially showed `csharp-ls.exe` PID 17496, parent PID 11740, started 2026-10-19T08:39:58.566Z. The command was `C:\Users\phila\.dotnet\tools\csharp-ls.exe` without arguments.
- A later snapshot showed PID 30108, again parent 11740, started 2026-10-19T08:43:00.8327430Z. The parent command was the repo-built Bun CLI running a background general worker in `D:\sources\CompanyLibs\developer-portal`. The worker's saved job record independently confirmed PID 11740 and that cwd.
- EnumWindows returned `30108|True|C:\Users\phila\.dotnet\tools\csharp-ls.exe`. Get-Process corroborated a nonzero MainWindowHandle (130354674). This establishes an actual visible console from the CLI-owned LSP child, not merely an installed executable or a hypothesized restart path.
- The installed tool's `--version` returned 0.26.0, exit 0. This investigation's own `--version`, `--help` and private fixture processes are excluded from the two worker-owned observations.
- PID 30108 remained alive across subsequent snapshots. Two launches were observed; their underlying restart/root-selection cause and an infinite respawn loop were **not established**. No production restart/backoff policy was changed.

## Small fix

`src/lsp/client.ts` now passes `windowsHide: true` to the existing child_process.spawn call. The existing executable/.cmd target resolver, arguments, stdio pipes and LSP protocol behavior are preserved.

The live worker/server was not killed, restarted or injected. New CLI/worker processes load the rebuilt fix; an already-loaded old LSP module retains its previous behavior.

## Fresh checks

- 37/37 tests passed, 3/3 files: spawn-target.test.ts, client-normalize.test.ts, manager.test.ts. `.scratch/csharp-lsp-20261019/tests.log`.
- Build including TypeScript compilation passed, exit 0. `.scratch/csharp-lsp-20261019/build.log`; source/build hashes in revision.json.
- Actual installed csharp-ls initialized using the freshly built client on private minimal C# projects under OS temp. No user project was indexed by the probes.
- Node 24.19.0: PID 66376, captured spawn option windowsHide=true, MainWindowHandle=0, empty title, initialization succeeded. hidden-client-node.json.
- Bun 1.3.13: PID 37392, observed as the probe's direct csharp child through CIM, MainWindowHandle=0, empty title, initialization succeeded. hidden-client.json. Bun's native named spawn binding was not intercepted by Node's mutable default export, so this result uses actual child/window observation rather than claiming an intercepted option.
- An earlier Bun fixture initialized successfully but failed its instrumentation when that interception returned no child. It is retained as hidden-client-bun-intercept-failed.json; the fixture was corrected without further production changes.

Evidence directory: `.scratch/csharp-lsp-20261019/`. No paid provider calls, settings changes, source changes in developer-portal, or termination of active user workers occurred. The Event Trace subscription was refused by Windows; subsequent evidence used read-only CIM snapshots and actual window enumeration, without elevated access.

## Closing the server followed by an edit: reproduced mechanism

Fresh actual-server control on 2026-10-19T12:03:12.508Z–12:03:15.128Z (`close-respawn.json`, `close-respawn.log`) used the built workspace manager/client and a private minimal C# project. Both child launches were hidden. It terminated only its own first language server, emulating the process loss from closing that console:

- First sync/edit: one server, PID 21536.
- After terminating that probe-owned server, next sync encountered the closed connection and removed its cached client. Launch count remained one for that sync.
- Following sync launched a replacement, PID 79644; launch count became two.
- Two further healthy syncs reused that replacement; launch count stayed two. No unconditional periodic respawn was observed in this control.

Production call chain: successful `edit_file`/`write_file` calls `syncFileWithLsp` in tools/file.ts; manager.syncFile drops a failed client; getClientsForFile creates the missing client on the following sync. Separately, native worker processes use detached:true plus unref in delegations.ts; main's cleanup shuts down its own workspace LSP manager, not all detached workers. Closing main therefore does not itself establish that those workers stopped.

This proves a concrete close -> closed-connection invalidation -> subsequent-edit respawn path. It does not prove why historical PID 17496 exited (manual close, process failure, or another lifecycle event); no exit trace was captured. The windowsHide fix suppresses visible consoles; it deliberately does not change auto-recovery or worker-lifetime policy.
