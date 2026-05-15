/**
 * init-new.ts — Scaffolds a new muonroi project with:
 *   - <name>/server/  cloned from muonroi-building-block (BE)
 *   - <name>/client/  scaffolded with React or Angular + SemanticProvider wiring
 *
 * Designed for testability: callers inject fs+exec via opts.fs to avoid
 * real I/O in unit tests. Only the smoke test uses real filesystem operations.
 */

import { exec as nodeExec } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(nodeExec);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InitNewOptions {
  /** Target directory name; created at projectsRoot (or cwd). */
  projectName: string;
  /** Absolute path or git URL for the muonroi-building-block source. */
  beSource: string;
  /** "react" | "angular" | "none" */
  feStack: "react" | "angular" | "none";
  /** Where to write the project. Defaults to process.cwd(). */
  projectsRoot?: string;
  /** Optional override: inject filesystem operations for testability. */
  fs?: {
    mkdir: (p: string) => Promise<void>;
    writeFile: (p: string, content: string) => Promise<void>;
    exec: (cmd: string, cwd: string) => Promise<{ stdout: string; stderr: string }>;
    exists: (p: string) => boolean;
  };
}

export interface InitNewResult {
  projectDir: string;
  /** Relative paths of files written (relative to projectDir). */
  files: string[];
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

function validateProjectName(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new Error("Project name cannot be empty.");
  }
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error(`Project name "${name}" contains path traversal characters. Use a simple name like "my-app".`);
  }
  if (!VALID_NAME_RE.test(name)) {
    throw new Error(
      `Project name "${name}" is invalid. Use kebab-case alphanumeric only (e.g. "my-app", "project1").`,
    );
  }
}

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

function rootPackageJson(projectName: string, hasClient: boolean): string {
  const workspaces = hasClient ? '["server", "client"]' : '["server"]';
  return JSON.stringify(
    {
      name: projectName,
      version: "0.1.0",
      private: true,
      workspaces: JSON.parse(workspaces),
      scripts: {
        dev: "bun run --filter='*' dev",
        build: "bun run --filter='*' build",
        test: "bun run --filter='*' test",
      },
    },
    null,
    2,
  );
}

function reactClientPackageJson(projectName: string): string {
  return JSON.stringify(
    {
      name: `${projectName}-client`,
      version: "0.1.0",
      private: true,
      scripts: {
        dev: "vite",
        build: "vite build",
        test: "vitest run",
      },
      dependencies: {
        react: "^18.3.0",
        "react-dom": "^18.3.0",
        "@muonroi/agent-harness-react": "^0.1.0",
      },
      devDependencies: {
        "@types/react": "^18.3.0",
        "@types/react-dom": "^18.3.0",
        "@vitejs/plugin-react": "^4.3.0",
        vite: "^5.4.0",
        vitest: "^2.0.0",
      },
    },
    null,
    2,
  );
}

function reactViteConfig(): string {
  return `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    __MUONROI_HARNESS__: JSON.stringify(process.env.NODE_ENV !== "production"),
  },
});
`;
}

function reactIndexHtml(projectName: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${projectName}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

function reactMainTsx(): string {
  return `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SemanticProvider, Semantic } from "@muonroi/agent-harness-react";
import { createSemanticRegistry } from "@muonroi/agent-harness-core/registry";

const registry = createSemanticRegistry();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SemanticProvider registry={registry}>
      <Semantic id="root" role="region" name="App root">
        {/* Your application components go here */}
        <h1>Hello from ${"{projectName}"}</h1>
      </Semantic>
    </SemanticProvider>
  </StrictMode>,
);
`;
}

function angularClientPackageJson(projectName: string): string {
  return JSON.stringify(
    {
      name: `${projectName}-client`,
      version: "0.1.0",
      private: true,
      scripts: {
        dev: "ng serve",
        build: "ng build",
        test: "ng test --watch=false",
      },
      dependencies: {
        "@angular/core": "^18.0.0",
        "@angular/common": "^18.0.0",
        "@angular/platform-browser": "^18.0.0",
        "@muonroi/agent-harness-angular": "^0.1.0",
      },
      devDependencies: {
        "@angular/cli": "^18.0.0",
        "@angular/compiler-cli": "^18.0.0",
        typescript: "^5.4.0",
      },
    },
    null,
    2,
  );
}

function angularMainTs(): string {
  return `import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component";

bootstrapApplication(AppComponent).catch(console.error);
`;
}

function angularAppComponentTs(projectName: string): string {
  return `import { Component } from "@angular/core";
import { SemanticDirective } from "@muonroi/agent-harness-angular";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [SemanticDirective],
  template: \`
    <div muonroiSemantic id="root" role="region" name="App root">
      <!-- Your application components go here -->
      <h1>Hello from ${projectName}</h1>
    </div>
  \`,
})
export class AppComponent {}
`;
}

function angularTsConfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        lib: ["ES2022", "dom"],
        strict: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: false,
        moduleResolution: "bundler",
      },
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Main scaffolder
// ---------------------------------------------------------------------------

export async function initNewProject(opts: InitNewOptions): Promise<InitNewResult> {
  const { projectName, beSource, feStack, projectsRoot } = opts;

  // 1. Validate project name.
  validateProjectName(projectName);

  // 2. Resolve project directory.
  const root = projectsRoot ?? process.cwd();
  const projectDir = path.join(root, projectName);

  // Inject or use real fs/exec.
  const fsOps = opts.fs ?? {
    mkdir: (p: string) => fsMkdir(p, { recursive: true }),
    writeFile: (p: string, content: string) => fsWriteFile(p, content, "utf-8"),
    exec: (cmd: string, cwd: string) => execAsync(cmd, { cwd }),
    exists: (p: string) => existsSync(p),
  };

  // 3. Refuse if projectDir already exists.
  if (fsOps.exists(projectDir)) {
    throw new Error(`Project directory already exists: ${projectDir}`);
  }

  const hasClient = feStack !== "none";
  const filesWritten: string[] = [];

  // Helper to write and track.
  async function write(relPath: string, content: string) {
    await fsOps.writeFile(path.join(projectDir, relPath), content);
    filesWritten.push(relPath);
  }

  // 4. Create project directories.
  await fsOps.mkdir(projectDir);
  await fsOps.mkdir(path.join(projectDir, "server"));
  if (hasClient) {
    await fsOps.mkdir(path.join(projectDir, "client"));
    await fsOps.mkdir(path.join(projectDir, "client", "src"));
    if (feStack === "angular") {
      await fsOps.mkdir(path.join(projectDir, "client", "src", "app"));
    }
  }

  // 5. Write root package.json.
  await write("package.json", rootPackageJson(projectName, hasClient));

  // 6. Clone BE source into server/.
  // Detect local path vs git URL: if existsSync or starts with a known git protocol.
  const cloneTarget = path.join(projectDir, "server");
  // Use the source as-is — git clone handles both local paths and URLs.
  await fsOps.exec(`git clone ${beSource} ${JSON.stringify(cloneTarget)}`, root);

  // 7. Scaffold FE client.
  if (feStack === "react") {
    await write("client/package.json", reactClientPackageJson(projectName));
    await write("client/vite.config.ts", reactViteConfig());
    await write("client/index.html", reactIndexHtml(projectName));
    await write("client/src/main.tsx", reactMainTsx());
  } else if (feStack === "angular") {
    await write("client/package.json", angularClientPackageJson(projectName));
    await write("client/tsconfig.json", angularTsConfig());
    await write("client/src/main.ts", angularMainTs());
    await write("client/src/app/app.component.ts", angularAppComponentTs(projectName));
  }

  return { projectDir, files: filesWritten };
}
