# Local EE Brain (Deliverable 6)
Scope: docs-only change. The local Experience Engine brain is NOT auto-started when
the CLI boots; the user opts in via the EE connect card.

## 1. End-to-end user flow

The user chooses the **Set up local brain** action in the EE connect card
(`src/ui/ee-connect-controller.ts:45`). That action calls
`connectSetupLocalEE`, which builds `brainDeps` from `defaultLocalBrainDeps()`
and forwards to `setupLocalBrain` (`src/ui/ee-connect-controller.ts:161-179`).

`setupLocalBrain` runs this pipeline in order
(`src/ee/local-brain.ts:343-461`):

1. **Probe-first** — checks `EE_LOCAL_URL` for an already-running brain.
   If healthy, it skips spawning and connects directly
   (`src/ee/local-brain.ts:372-380`).
2. **Resolve package root** via `resolveLocalBrainPackageRoot`
   (`src/ee/local-brain.ts:383`). If no root is found, it fails with the exact
   install command plus the `MUONROI_EE_PACKAGE_ROOT` hint
   (`src/ee/local-brain.ts:386-392`).
3. **Pre-create the store directory** `<home>/.experience/store/default`
   (`src/ee/local-brain.ts:395-401`). This avoids a degraded `/health` report.
4. **Pick a free port** with `findFreePort()`
   (`src/ee/local-brain.ts:404-408`). The port is never assumed to be 8082.
5. **Spawn a detached `node <serverRoot>/server.js`** with `HOME` and
   `USERPROFILE` set to the resolved home, and `EXP_SERVER_PORT` set to the
   chosen port (`src/ee/local-brain-spawn.ts:230-237`, `src/ee/local-brain-spawn.ts:323-333`).
   The spawn is detached + unref so the brain outlives the CLI session
   (`src/ee/local-brain-spawn.ts:328-329`).
6. **Poll `/health`** every 500 ms (up to 45 000 ms)
   (`src/ee/local-brain.ts:53`, `src/ee/local-brain.ts:56`, `src/ee/local-brain.ts:420-448`).
7. **Write config, reload auth, record connection** — once healthy,
   `connectBrain` writes `serverBaseUrl` into `<home>/.experience/config.json`
   via `writeExperienceConfig({ serverBaseUrl }, { home })`
   (`src/ee/local-brain.ts:319-322`, `src/ee/auth.ts:71-89`), reloads the auth
   cache for that home, and records the EE connection
   (`src/ee/local-brain.ts:312-337`).

## 2. `MUONROI_EE_PACKAGE_ROOT` env knob

Defined as `LOCAL_BRAIN_ROOT_ENV` (`src/ee/local-brain.ts:62`).

- When set, `resolveLocalBrainPackageRoot` uses it as the package root
  immediately and skips every other lookup (`src/ee/local-brain.ts:274-276`).
- When unset, the search order is
  (`src/ee/local-brain.ts:265-297`):
  1. `createRequire(import.meta.url).resolve("<spec>/server.js")`
     — resolves the installed package via Node's module graph.
  2. Platform-aware global roots:
     - Windows: `<APPDATA>/npm/node_modules`
     - POSIX: `/usr/local/lib/node_modules`
     - plus `<home>/.bun/install/global/node_modules`
  3. `npm root -g` (spawned with `windowsHide`, 15 s timeout).
- If all lookups fail, the actionable error names both the install command
  (`npm i -g @muonroi/experience-engine`) and the env knob
  (`src/ee/local-brain.ts:386-392`).

## 3. `EXP_SERVER_PORT` and port selection

The brain's `server.js` defaults to 8082. `EXP_SERVER_PORT` overrides that
default inside the child process (`src/ee/local-brain-spawn.ts:235`).

The CLI never assumes 8082. `findFreePort()` binds to `127.0.0.1:0`, reads the
OS-assigned port, then closes the socket and returns that port
(`src/ee/local-brain.ts:156-175`). That port is passed to `spawnLocalBrain`,
which writes it into the pidfile and sets `EXP_SERVER_PORT` in the child env
(`src/ee/local-brain-spawn.ts:230-237`, `src/ee/local-brain-spawn.ts:357-363`).

## 4. Stopping a started brain

A brain started by `setupLocalBrain` is tracked by a pidfile at
`<home>/local-brain.json` (`src/ee/local-brain-spawn.ts:218-220`). The file
is written as `<pid>.tmp` then renamed, and the read-back is verified before
spawn returns success (`src/ee/local-brain-spawn.ts:364-408`).

Pidfile fields (`src/ee/local-brain-spawn.ts:93-102`):
- `pid`, `port`, `startedAt`, `logPath`, `serverRoot`

### Automatic stop
If the brain does not become healthy within the timeout, `setupLocalBrain` kills
the child, reports the log tail, and returns an error
(`src/ee/local-brain.ts:424-446`).

### Manual stop via the CLI
`killLocalBrain` reads the pidfile and verifies ALL of the following before
signalling (`src/ee/local-brain-spawn.ts:580-668`):
- The pidfile exists and is valid JSON with the expected shape.
- The recorded pid is alive (signal 0 probe).
- The recorded port is owned by that same pid.
- The recorded pid's command line contains the brain's `server.js` (and
  `serverRoot`).
Any failure is a refusal with a refusal reason (`no-pidfile`, `stale`,
`port-unknown`, `port-mismatch`, `cmdline-unknown`, `cmdline-mismatch`,
`signal-failed`).

Signalling itself is platform-specific:
- Windows: `taskkill /pid <pid> /T /F`
- POSIX: `SIGTERM`
(`src/ee/local-brain-spawn.ts:512-520`)

### Manual stop by hand
If `killLocalBrain` cannot verify the pidfile or the checks fail, the error
text explicitly tells the operator to stop the process manually. A typical
manual stop is `tasklist` / `taskkill` on Windows or `kill` / `lsof` on POSIX,
followed by removing `<home>/local-brain.json` if the tracking file is stale.
