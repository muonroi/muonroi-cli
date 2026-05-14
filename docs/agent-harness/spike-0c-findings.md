# Phase 0c spike findings — Bun extra-fd on Windows

## Environment
- Platform: win32 (Windows 10 Enterprise 10.0.19045)
- Bun: 1.3.13
- Node: v20.19.0

## Result
- **Bun.spawn with 5-element stdio: FAILS** — `proc.stdio[3]` and `proc.stdio[4]` are returned as raw Windows HANDLE integers (e.g., `660`, `668`), not `ReadableStream` objects. Attempting to read from these values via `createReadStream({ fd })`, `Bun.file(fd)`, or `node:net.Socket({ fd })` all fail with `EBADF: bad file descriptor`. Bun only exposes proper stream objects for the first three indices via `proc.stdin`, `proc.stdout`, `proc.stderr` — extra fds beyond index 2 are not readable from the parent process on Windows.

- **Node child_process.spawn with 5-element stdio: WORKS** — `proc.stdio[3]` is a `Socket` (readable stream). The child writing `"hello-from-fd3\n"` to fd 3 via `createWriteStream("", { fd: 3 })` is correctly received in the parent via `fd3.on("data", ...)`. Confirmed: `NODE-FD3: "hello-from-fd3\n"`.

## Bun type investigation
No `bun-types` package is installed in this project's `node_modules`. Bun's built-in spawn types expose `stdio` as an array but make no guarantees about extra fds being streams. Confirmed by runtime introspection: all proc properties are `connected`, `disconnect`, `exitCode`, `exited`, `kill`, `killed`, `pid`, `readable`, `ref`, `resourceUsage`, `send`, `signalCode`, `stderr`, `stdin`, `stdio`, `stdout`, `terminal`, `unref`, `writable` — there is no `extraFd` property or documented stream API for indices ≥ 3.

## Decision for Phase 1
Choose ONE:
- [ ] Use `Bun.spawn` with `stdio: [..., 'pipe', 'pipe', 'pipe']` on both POSIX and Windows.
- [ ] Use `Bun.spawn` on POSIX; fall back to Node `child_process.spawn` on Windows for the harness driver.
- [x] **Use Node `child_process.spawn` everywhere (simpler, consistent).**

## Raw output

### parent-bun.ts (Bun.spawn, 5-element stdio)
```
2 |   stdio: ["inherit", "inherit", "pipe", "pipe", "pipe"] as never,
3 | });
4 | // Try to read fd 3 from proc — Bun-specific API
5 | const out = (proc as unknown as { stdio: ReadableStream[] }).stdio?.[3];
6 | if (!out) { console.error("BUN: no proc.stdio[3]"); process.exit(2); }
7 | const reader = out.getReader();
                       ^
TypeError: out.getReader is not a function. (In 'out.getReader()', 'out.getReader' is undefined)
      at D:\sources\Core\muonroi-cli\src\agent-harness\__spike0c__\parent-bun.ts:7:20
Bun v1.3.13 (Windows x64)
EXIT:1
```

### Bun proc.stdio inspection (with 5-element stdio)
```
proc keys: (empty — non-enumerable)
stdio type: object
stdio: [null, null, null, 660, 668]
stdin: undefined
stdout: undefined
stderr: object (ReadableStream)
```
Note: `stdio[2]` (pipe) returns `null` in the array but is accessible via `proc.stderr`. Indices 3 and 4 return raw Windows HANDLE integers with no stream wrapper.

### parent-node.ts (Node child_process.spawn, 5-element stdio)
```
NODE-FD3: hello-from-fd3
EXIT:0
```

### Node proc.stdio[3] inspection
```
fd3 type: object Socket
NODE-FD3: "hello-from-fd3\n"
fd3 ended
exit: 0
EXIT:0
```

## Implementer guidance
Use `node:child_process.spawn` for spawning agent harness children on Windows (and all platforms for consistency). The harness driver should import from `node:child_process` and access `proc.stdio[3]` / `proc.stdio[4]` as Node `Socket` streams for JSONL communication. This is simpler than a platform-conditional code path and avoids Bun's Windows limitation entirely — since the CLI itself runs under Bun, `node:child_process` is available with full Node compatibility.
