import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listBuiltInServerMeta } from "../builtins.js";
import {
  detectProjectLanguages,
  installLspServer,
  installLspServers,
  isLspServerInstalled,
  LSP_INSTALL_RECIPES,
  type LspSetupDeps,
} from "../lsp-setup.js";
import type { LspBuiltInServerId } from "../types.js";

function makeDeps(overrides: Partial<LspSetupDeps> = {}): LspSetupDeps {
  return {
    which: vi.fn(async () => null),
    spawnInstall: vi.fn(async () => ({ ok: true, detail: "ok" })),
    warmNpm: vi.fn(async () => "/cache/bin/server"),
    cachedNpm: vi.fn(async () => null),
    ...overrides,
  };
}

describe("LSP_INSTALL_RECIPES classification", () => {
  it("covers every built-in server id exactly (single source of truth)", () => {
    const builtinIds = listBuiltInServerMeta().map((s) => s.id);
    expect(Object.keys(LSP_INSTALL_RECIPES).sort()).toEqual([...builtinIds].sort());
  });

  it("classifies npm-based servers as auto-installable", () => {
    for (const id of ["typescript", "pyright", "bash-language-server", "yaml-language-server"] as const) {
      expect(LSP_INSTALL_RECIPES[id].kind).toBe("npm");
      expect(LSP_INSTALL_RECIPES[id].npm).toBeDefined();
    }
  });

  it("classifies toolchain servers with their required toolchain binary", () => {
    expect(LSP_INSTALL_RECIPES.gopls.toolchain?.bin).toBe("go");
    expect(LSP_INSTALL_RECIPES["rust-analyzer"].toolchain?.bin).toBe("rustup");
    expect(LSP_INSTALL_RECIPES["csharp-ls"].toolchain?.bin).toBe("dotnet");
  });

  it("classifies OS-dependent servers as manual (never auto-run)", () => {
    for (const id of ["clangd", "jdtls", "sourcekit-lsp"] as const) {
      expect(LSP_INSTALL_RECIPES[id].kind).toBe("manual");
      expect(LSP_INSTALL_RECIPES[id].manualCommand).toBeTruthy();
    }
  });
});

describe("installLspServer", () => {
  it("reports installed without any install work when the binary is on PATH", async () => {
    const deps = makeDeps({ which: vi.fn(async () => "/usr/bin/gopls") });
    const status = await installLspServer("gopls", deps);
    expect(status.status).toBe("installed");
    expect(deps.spawnInstall).not.toHaveBeenCalled();
    expect(deps.warmNpm).not.toHaveBeenCalled();
  });

  it("npm: warms the cache and reports installed", async () => {
    const deps = makeDeps();
    const status = await installLspServer("typescript", deps);
    expect(status.status).toBe("installed");
    expect(deps.warmNpm).toHaveBeenCalledWith("typescript-language-server", "typescript-language-server");
  });

  it("npm: an already-warmed cache short-circuits the install", async () => {
    const deps = makeDeps({ cachedNpm: vi.fn(async () => "/cache/.bin/pyright-langserver") });
    const status = await installLspServer("pyright", deps);
    expect(status.status).toBe("installed");
    expect(deps.warmNpm).not.toHaveBeenCalled();
  });

  it("npm: a failed warm reports failed (never throws)", async () => {
    const deps = makeDeps({ warmNpm: vi.fn(async () => null) });
    const status = await installLspServer("yaml-language-server", deps);
    expect(status.status).toBe("failed");
  });

  it("toolchain present: runs the safe one-line install command", async () => {
    const which = vi.fn(async (bin: string) => (bin === "go" ? "/usr/bin/go" : null));
    const deps = makeDeps({ which });
    const status = await installLspServer("gopls", deps);
    expect(status.status).toBe("installed");
    expect(deps.spawnInstall).toHaveBeenCalledWith("go", ["install", "golang.org/x/tools/gopls@latest"]);
  });

  it("toolchain present but install fails: reports failed with the manual fallback command", async () => {
    const which = vi.fn(async (bin: string) => (bin === "rustup" ? "/usr/bin/rustup" : null));
    const deps = makeDeps({ which, spawnInstall: vi.fn(async () => ({ ok: false, detail: "boom" })) });
    const status = await installLspServer("rust-analyzer", deps);
    expect(status.status).toBe("failed");
    expect(status.detail).toBe("boom");
    expect(status.command).toBe("rustup component add rust-analyzer");
  });

  it("toolchain missing: returns manual with the exact command, never spawns", async () => {
    const deps = makeDeps();
    const status = await installLspServer("csharp-ls", deps);
    expect(status).toMatchObject({ status: "manual", command: "dotnet tool install -g csharp-ls" });
    expect(deps.spawnInstall).not.toHaveBeenCalled();
  });

  it("manual kind: returns the copyable command, never runs anything", async () => {
    const deps = makeDeps();
    for (const id of ["clangd", "jdtls", "sourcekit-lsp"] as const) {
      const status = await installLspServer(id, deps);
      expect(status.status).toBe("manual");
      expect(status.command).toBe(LSP_INSTALL_RECIPES[id].manualCommand);
    }
    expect(deps.spawnInstall).not.toHaveBeenCalled();
    expect(deps.warmNpm).not.toHaveBeenCalled();
  });

  it("never throws — a broken dep resolves to failed", async () => {
    const deps = makeDeps({
      which: vi.fn(async () => {
        throw new Error("PATH exploded");
      }),
    });
    const status = await installLspServer("typescript", deps);
    expect(status.status).toBe("failed");
    expect(status.detail).toContain("PATH exploded");
  });
});

describe("installLspServers", () => {
  it("resolves one status per requested id, in order", async () => {
    const deps = makeDeps();
    const ids: LspBuiltInServerId[] = ["typescript", "clangd"];
    const statuses = await installLspServers(ids, deps);
    expect(statuses.map((s) => s.id)).toEqual(ids);
    expect(statuses[0]?.status).toBe("installed");
    expect(statuses[1]?.status).toBe("manual");
  });
});

describe("isLspServerInstalled", () => {
  it("true when the binary resolves on PATH", async () => {
    const deps = makeDeps({ which: vi.fn(async () => "/usr/bin/clangd") });
    await expect(isLspServerInstalled("clangd", deps)).resolves.toBe(true);
  });

  it("true for npm servers already in the warm cache", async () => {
    const deps = makeDeps({ cachedNpm: vi.fn(async () => "/cache/.bin/typescript-language-server") });
    await expect(isLspServerInstalled("typescript", deps)).resolves.toBe(true);
  });

  it("false when nothing resolves (and never throws)", async () => {
    await expect(isLspServerInstalled("gopls", makeDeps())).resolves.toBe(false);
    const broken = makeDeps({
      which: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(isLspServerInstalled("gopls", broken)).resolves.toBe(false);
  });
});

describe("detectProjectLanguages", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("detects languages by file extension and root marker (canonical order)", async () => {
    dir = mkdtempSync(join(tmpdir(), "muonroi-lsp-detect-"));
    writeFileSync(join(dir, "main.py"), "print()\n");
    writeFileSync(join(dir, "go.mod"), "module x\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "app.ts"), "export {}\n");
    const ids = await detectProjectLanguages(dir);
    expect(ids).toEqual(["typescript", "pyright", "gopls"]);
  });

  it("ignores node_modules and dot directories, and does not match on .git alone", async () => {
    dir = mkdtempSync(join(tmpdir(), "muonroi-lsp-detect-"));
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "dep", "index.rs"), "fn main() {}\n");
    const ids = await detectProjectLanguages(dir);
    expect(ids).toEqual([]);
  });

  it("fail-open: a missing directory yields no detections, never a throw", async () => {
    await expect(detectProjectLanguages("/definitely/not/a/dir")).resolves.toEqual([]);
  });
});
