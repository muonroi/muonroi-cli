/** Command policy, not an OS sandbox. Native process_stop retains ownership checks. */
const TERMINATORS = new Set(["taskkill", "tskill", "kill", "killall", "pkill", "stop-process", "spps"]);
const SHELLS = new Set(["cmd", "powershell", "pwsh", "bash", "sh", "zsh"]);
const PREFIXES = new Set(["sudo", "exec", "command", "env", "nohup", "then", "do", "else", "xargs"]);

export function workerProcessRefusal(command: string, depth = 0): string | undefined {
  // Retain quoted words so printed/search strings are not interpreted as commands.
  const tokens = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[;&|()\r\n]+|[^\s;&|()]+/g) ?? [];
  let start = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (/^[;&|()\r\n]+$/.test(token)) {
      start = true;
      continue;
    }
    if (!start) continue;
    const word = token.replace(/^["']|["']$/g, "");
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || /^-/.test(word)) continue;
    const name = word
      .replace(/\\/g, "/")
      .split("/")
      .pop()!
      .replace(/\.exe$/i, "")
      .toLowerCase();
    if (PREFIXES.has(name)) continue;
    start = false;
    if (TERMINATORS.has(name)) return refusal();
    if (name === "wmic" && tokens.slice(i + 1).some((t) => /^(?:terminate|delete)$/i.test(t))) return refusal();
    if (name === "dotnet") {
      const args = tokens.slice(i + 1).map((t) => t.replace(/^["']|["']$/g, "").toLowerCase());
      if (
        (args[0] === "build-server" && args[1] === "shutdown") ||
        (args[0] === "nuget" && args[1] === "locals" && args.some((t) => t === "--clear" || t === "-c"))
      )
        return refusal();
    }
    if (SHELLS.has(name)) {
      const tail = tokens.slice(i + 1);
      const switchIndex = tail.findIndex((t) => /^(?:\/\/?[ck]|-[a-z]*c|-(?:command|c))$/i.test(t));
      if (switchIndex >= 0) {
        // Shell command strings are code. Other quoted arguments remain data.
        const body = tail.slice(switchIndex + 1).join(" ");
        const unwrapped = /^("[\s\S]*"|'[\s\S]*')$/.test(body) ? body.slice(1, -1) : body;
        if (depth >= 4 || workerProcessRefusal(unwrapped, depth + 1)) return refusal();
      }
    }
  }
  return undefined;
}

function refusal(): string {
  return (
    "BLOCKED (worker_process_boundary): no command executed. Workers cannot terminate processes through shell commands or shut down shared build servers/clear shared package caches. " +
    "Use process_list and process_stop with this worker's native background ID (not an OS PID). For external contention, return the exact command/error and ownership evidence to main; do not kill processes or clear caches. This boundary is not bypassed by yolo or safety approval."
  );
}
