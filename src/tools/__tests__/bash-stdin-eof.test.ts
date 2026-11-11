import os from "node:os";
import { expect, it } from "vitest";
import { BashTool } from "../bash.js";

it.skipIf(process.platform !== "win32")(
  "refuses path-converted cmd /c instead of claiming a prompt-only success",
  async () => {
    const bash = new BashTool(os.tmpdir(), { shellSettings: { kind: "bash" } });
    try {
      for (const command of ["cmd /c echo MSYS_SENTINEL", 'cmd "/c" echo MSYS_SENTINEL']) {
        const result = await bash.execute(command, 1500);
        expect(result.success).toBe(false);
        expect(result.error).toContain("msys_cmd_switch");
        expect(result.error).toContain("cmd //c");
      }
    } finally {
      await bash.cleanup();
    }
  },
  10000,
);

it("foreground commands receive EOF instead of waiting indefinitely for inaccessible stdin", async () => {
  const bash = new BashTool(os.tmpdir());
  try {
    // The bound only needs to separate "EOF arrived" from "stdin never closes"
    // (which waits forever). 1500ms also had to cover spawning node, and on a
    // loaded machine that alone exceeded it (sharded full run on ci/matrix-fix:
    // "expected false to be true" at the success check; 3/3 green in isolation).
    const result = await bash.execute(
      "node -e \"process.stdin.resume();process.stdin.on('end',()=>console.log('STDIN_EOF'))\"",
      8000,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("STDIN_EOF");
  } finally {
    await bash.cleanup();
  }
}, 20000);
