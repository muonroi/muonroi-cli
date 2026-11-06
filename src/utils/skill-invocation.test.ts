import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSkillSlashCommand } from "./skill-invocation";
import { resetSkillsCache } from "./skills";

const tempDirs: string[] = [];

function repoWithSkill(name: string, body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-skill-invoke-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  const dir = path.join(root, ".agents", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill.\n---\n\n${body}\n`);
  return root;
}

afterEach(() => {
  resetSkillsCache();
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const none = () => false;

describe("resolveSkillSlashCommand", () => {
  it("/skill <name> args substitutes $ARGUMENTS and keeps the typed text as display", () => {
    const root = repoWithSkill("ship-it", "Ship version $ARGUMENTS now.");
    const r = resolveSkillSlashCommand("/skill ship-it 1.2.3", root, none);
    expect(r?.kind).toBe("invoke");
    if (r?.kind !== "invoke") return;
    expect(r.display).toBe("/skill ship-it 1.2.3");
    expect(r.message).toContain("Ship version 1.2.3 now.");
    expect(r.message).toContain('The user invoked the skill "ship-it" with arguments: 1.2.3');
    expect(r.message).not.toContain("---\nname:");
  });

  it("appends ARGUMENTS when the body has no placeholder", () => {
    const root = repoWithSkill("plain", "Do the plain thing.");
    const r = resolveSkillSlashCommand("/plain extra words", root, none);
    expect(r?.kind === "invoke" && r.message).toContain("ARGUMENTS: extra words");
  });

  it("never shadows a command that already owns the name", () => {
    const root = repoWithSkill("plan", "Skill body.");
    expect(resolveSkillSlashCommand("/plan", root, (n) => n === "plan")).toBeNull();
    expect(resolveSkillSlashCommand("/skill plan", root, (n) => n === "plan")?.kind).toBe("invoke");
  });

  it("returns null for an unknown /<name> and a usage/error for /skill", () => {
    const root = repoWithSkill("known", "Body.");
    expect(resolveSkillSlashCommand("/unknown-thing", root, none)).toBeNull();
    expect(resolveSkillSlashCommand("not a command", root, none)).toBeNull();
    const usage = resolveSkillSlashCommand("/skill", root, none);
    expect(usage?.kind === "error" && usage.text).toContain("Usage: /skill <name> [args]");
    const missing = resolveSkillSlashCommand("/skill nope", root, none);
    expect(missing?.kind === "error" && missing.text).toContain('Unknown skill "nope"');
    expect(missing?.kind === "error" && missing.text).toContain("known");
  });
});
