import { promises as fs } from "node:fs";
import * as path from "node:path";
import { slugify } from "../utils/slugify.js";
import type { ProductSpec } from "./types.js";

/**
 * Ship-time delivery polish. Called once when a /ideal run reaches the
 * shipped stage; idempotent so resume + re-ship don't clobber user content.
 *
 * What it does:
 *  - If no README.md exists in cwd, generate one from the ProductSpec.
 *  - If package.json exists and is missing name/description, fill them
 *    (NEVER overwrite existing fields — user-edited values win).
 *  - Always writes a delivery-notes.md inside the run dir summarizing
 *    what was generated. Caller can surface this to the user.
 *
 * Intentionally does NOT run `git init` or create commits — too invasive
 * for an autonomous loop. User can run git themselves after the ship.
 */
export interface PolishOptions {
  cwd: string;
  runDir: string;
  productSpec: ProductSpec;
  runId: string;
}

export interface PolishResult {
  readmeWritten: boolean;
  packageJsonUpdated: boolean;
  /** Files that already existed and were left alone (paths relative to cwd). */
  preserved: string[];
  notes: string[];
}

export async function polishDelivery(opts: PolishOptions): Promise<PolishResult> {
  const out: PolishResult = {
    readmeWritten: false,
    packageJsonUpdated: false,
    preserved: [],
    notes: [],
  };

  await maybeWriteReadme(opts, out);
  await maybeFillPackageJson(opts, out);
  await writeDeliveryNotes(opts, out);

  return out;
}

async function maybeWriteReadme(opts: PolishOptions, out: PolishResult): Promise<void> {
  const readmePath = path.join(opts.cwd, "README.md");
  if (await fileExists(readmePath)) {
    out.preserved.push("README.md");
    out.notes.push("README.md already exists — left alone.");
    return;
  }

  const spec = opts.productSpec;
  const lines: string[] = [];
  const title = spec.idea.split(/[.!?\n]/)[0]?.trim() || "Project";
  lines.push(`# ${title.slice(0, 80)}`);
  lines.push("");
  if (spec.idea && spec.idea !== title) {
    lines.push(spec.idea);
    lines.push("");
  }
  if (spec.persona) {
    lines.push("## Audience");
    lines.push(spec.persona);
    lines.push("");
  }
  if (spec.mvp?.length) {
    lines.push("## Features");
    for (const m of spec.mvp) lines.push(`- ${m}`);
    lines.push("");
  }
  if (spec.architecture) {
    lines.push("## Architecture");
    lines.push(spec.architecture);
    lines.push("");
  }
  if (spec.ioContract) {
    lines.push("## Interface");
    lines.push("```");
    lines.push(spec.ioContract);
    lines.push("```");
    lines.push("");
  }
  if (spec.phase2?.length) {
    lines.push("## Roadmap");
    for (const p of spec.phase2) lines.push(`- ${p}`);
    lines.push("");
  }
  lines.push("---");
  lines.push(`_Scaffolded by muonroi-cli /ideal run ${opts.runId}_`);

  await fs.writeFile(readmePath, lines.join("\n"), "utf-8");
  out.readmeWritten = true;
  out.notes.push("Wrote README.md from ProductSpec.");
}

async function maybeFillPackageJson(opts: PolishOptions, out: PolishResult): Promise<void> {
  const pkgPath = path.join(opts.cwd, "package.json");
  let raw: string;
  try {
    raw = await fs.readFile(pkgPath, "utf-8");
  } catch {
    return; // No package.json → not a Node project, skip silently.
  }
  let pkg: any;
  try {
    pkg = JSON.parse(raw);
  } catch {
    out.notes.push("package.json present but unparseable — left alone.");
    return;
  }

  let touched = false;
  const first = opts.productSpec.idea.split(/[.!?\n]/)[0]?.trim();
  const slugged = first ? slugify(first).slice(0, 60) || undefined : undefined;
  if (!pkg.name && slugged) {
    pkg.name = slugged;
    touched = true;
  }
  if (!pkg.description && opts.productSpec.idea) {
    pkg.description = opts.productSpec.idea.slice(0, 140);
    touched = true;
  }
  if (!pkg.version) {
    pkg.version = "0.1.0";
    touched = true;
  }

  if (touched) {
    // Preserve trailing newline + 2-space indent — matches npm defaults so
    // the diff stays clean for users on a managed package.json.
    await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
    out.packageJsonUpdated = true;
    out.notes.push("Filled missing name/description/version in package.json.");
  } else {
    out.preserved.push("package.json");
    out.notes.push("package.json already populated — left alone.");
  }
}

async function writeDeliveryNotes(opts: PolishOptions, out: PolishResult): Promise<void> {
  const notesPath = path.join(opts.runDir, "delivery-notes.md");
  const lines = ["## Delivery", ""];
  if (out.readmeWritten) lines.push("- README.md generated from ProductSpec");
  if (out.packageJsonUpdated) lines.push("- package.json metadata filled");
  for (const p of out.preserved) lines.push(`- ${p} preserved (already existed)`);
  if (lines.length === 2) lines.push("- nothing to scaffold (all artifacts already present)");
  lines.push("");
  await fs.writeFile(notesPath, lines.join("\n"), "utf-8");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
