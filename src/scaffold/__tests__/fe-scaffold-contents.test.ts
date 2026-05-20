/**
 * Verifies the FE scaffold writes a real app skeleton — not just a hello-world.
 * Backed by the Todo_App/client review: scaffolded clients were too thin
 * (no env config, no typed API client, no error boundary, no design tokens).
 */
import { describe, expect, it } from "vitest";
import { initNewProject } from "../init-new.js";

interface MemFs {
  paths: Set<string>;
  files: Map<string, string>;
}

function makeFs(): MemFs & {
  mkdir: (p: string) => Promise<void>;
  writeFile: (p: string, c: string) => Promise<void>;
  exec: (cmd: string, cwd: string) => Promise<{ stdout: string; stderr: string }>;
  exists: (p: string) => boolean;
} {
  const paths = new Set<string>();
  const files = new Map<string, string>();
  return {
    paths,
    files,
    mkdir: async (p: string) => {
      paths.add(p);
    },
    writeFile: async (p: string, c: string) => {
      files.set(p.replace(/\\/g, "/"), c);
    },
    exec: async () => ({ stdout: "", stderr: "" }),
    exists: () => false,
  };
}

describe("FE scaffold contents (React)", () => {
  it("writes env, tsconfig, gitignore, README, api/, components/, styles/", async () => {
    const fs = makeFs();
    await initNewProject({
      projectName: "demo-app",
      feStack: "react",
      projectsRoot: "/tmp",
      fs,
    });

    const has = (suffix: string): boolean => Array.from(fs.files.keys()).some((p) => p.endsWith(suffix));

    expect(has("client/.env.example"), ".env.example").toBe(true);
    expect(has("client/.gitignore"), ".gitignore").toBe(true);
    expect(has("client/README.md"), "README.md").toBe(true);
    expect(has("client/tsconfig.json"), "tsconfig.json").toBe(true);
    expect(has("client/src/api/client.ts"), "api/client.ts").toBe(true);
    expect(has("client/src/api/types.ts"), "api/types.ts").toBe(true);
    expect(has("client/src/components/ErrorBoundary.tsx"), "ErrorBoundary").toBe(true);
    expect(has("client/src/styles/app.css"), "styles/app.css").toBe(true);
  });

  it("tsconfig has strict: true", async () => {
    const fs = makeFs();
    await initNewProject({ projectName: "demo-app", feStack: "react", projectsRoot: "/tmp", fs });
    const tsconfig = Array.from(fs.files.entries()).find(([p]) => p.endsWith("client/tsconfig.json"))?.[1];
    expect(tsconfig).toBeTruthy();
    const parsed = JSON.parse(tsconfig!) as { compilerOptions: Record<string, unknown> };
    expect(parsed.compilerOptions.strict).toBe(true);
  });

  it("env.example references VITE_API_BASE, no hardcoded URL in api/client", async () => {
    const fs = makeFs();
    await initNewProject({ projectName: "demo-app", feStack: "react", projectsRoot: "/tmp", fs });
    const env = Array.from(fs.files.entries()).find(([p]) => p.endsWith("client/.env.example"))?.[1];
    const api = Array.from(fs.files.entries()).find(([p]) => p.endsWith("client/src/api/client.ts"))?.[1];
    expect(env).toContain("VITE_API_BASE");
    expect(api).toContain("import.meta.env.VITE_API_BASE");
    // No hardcoded localhost URL in the api client body
    expect(api).not.toMatch(/http:\/\/localhost/);
  });

  it("main.tsx still imports SemanticProvider and now imports ErrorBoundary + styles", async () => {
    const fs = makeFs();
    await initNewProject({ projectName: "demo-app", feStack: "react", projectsRoot: "/tmp", fs });
    const main = Array.from(fs.files.entries()).find(([p]) => p.endsWith("client/src/main.tsx"))?.[1];
    expect(main).toContain("SemanticProvider");
    expect(main).toContain("ErrorBoundary");
    expect(main).toContain("./styles/app.css");
  });
});

describe("FE scaffold contents (Angular)", () => {
  it("writes environments/, api/, error-handler, styles, README, gitignore", async () => {
    const fs = makeFs();
    await initNewProject({
      projectName: "demo-app",
      feStack: "angular",
      projectsRoot: "/tmp",
      fs,
    });

    const has = (suffix: string): boolean => Array.from(fs.files.keys()).some((p) => p.endsWith(suffix));

    expect(has("client/.gitignore"), ".gitignore").toBe(true);
    expect(has("client/README.md"), "README.md").toBe(true);
    expect(has("client/src/styles.css"), "styles.css").toBe(true);
    expect(has("client/src/environments/environment.ts"), "environment.ts").toBe(true);
    expect(has("client/src/environments/environment.prod.ts"), "environment.prod.ts").toBe(true);
    expect(has("client/src/api/api.service.ts"), "api.service.ts").toBe(true);
    expect(has("client/src/api/types.ts"), "api types").toBe(true);
    expect(has("client/src/app/error-handler.ts"), "error-handler.ts").toBe(true);
  });

  it("main.ts wires AppErrorHandler + provideHttpClient + styles", async () => {
    const fs = makeFs();
    await initNewProject({ projectName: "demo-app", feStack: "angular", projectsRoot: "/tmp", fs });
    const main = Array.from(fs.files.entries()).find(([p]) => p.endsWith("client/src/main.ts"))?.[1];
    expect(main).toContain("AppErrorHandler");
    expect(main).toContain("provideHttpClient");
    expect(main).toContain("./styles.css");
  });

  it("environment.ts has apiBase, api.service reads from environment", async () => {
    const fs = makeFs();
    await initNewProject({ projectName: "demo-app", feStack: "angular", projectsRoot: "/tmp", fs });
    const env = Array.from(fs.files.entries()).find(([p]) => p.endsWith("environments/environment.ts"))?.[1];
    const api = Array.from(fs.files.entries()).find(([p]) => p.endsWith("api/api.service.ts"))?.[1];
    expect(env).toContain("apiBase");
    expect(api).toContain("environment.apiBase");
  });
});
