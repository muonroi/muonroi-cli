const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist", "src");
// Retire only obsolete generated workflow modules, never source or shared skills.
for (const rel of ["gsd", "pil/layer4-gsd.js", "pil/layer4-gsd.d.ts"]) {
  const target = path.resolve(dist, rel);
  if (!target.startsWith(dist + path.sep)) throw new Error("Invalid generated workflow target");
  fs.rmSync(target, { recursive: true, force: true });
}
fs.cpSync(path.join(root, "src/workflow/skills"), path.join(dist, "workflow/skills"), { recursive: true });
