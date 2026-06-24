import { readFileSync, writeFileSync } from "node:fs";

// NOTE (Plan 23-02): This patch script targets the pre-Plan-23 state of
// src/ui/app.tsx and is now STALE. The current app.tsx contains:
//   - Plan 23-02: lastIdealIdeaRef capture, EE design routing in fe-stack
//     Enter handler, designing/design-preview keyboard blocks
//   - bb-template manual picker step (Task 6.2a)
//   - point-to-existing form intercept block
// None of these anchors exist in the patches below — running this script
// against the current app.tsx will fail on step 3 (TODO halt handler) or
// step 4 (halt guard block already replaced) and exit non-zero, which is
// the desired safe behavior.
//
// If a future refactor wants to regenerate app.tsx from scratch via this
// script, update each patch block to match the current state-of-the-art
// behavior in src/ui/app.tsx including the EE design flow.

let src = readFileSync("src/ui/app.tsx", "utf-8");

// ---------------------------------------------------------------------------
// 1. Add imports after HaltRecoveryCard import
// ---------------------------------------------------------------------------
const oldImport = `import { HaltRecoveryCard } from "./components/halt-recovery-card.js";`;
const newImport = `import { HaltRecoveryCard } from "./components/halt-recovery-card.js";
import {
  FE_STACK_OPTIONS,
  InitNewFormCard,
  type InitNewFormState,
  initialInitNewFormState,
} from "./components/init-new-form-card.js";
import { initNewProject } from "../scaffold/init-new.js";`;

if (!src.includes(oldImport)) {
  console.error("FAIL: could not find HaltRecoveryCard import");
  process.exit(1);
}
src = src.replace(oldImport, newImport);

// ---------------------------------------------------------------------------
// 2. Add state after haltSelectedIndex
// ---------------------------------------------------------------------------
const oldState = `  const [haltSelectedIndex, setHaltSelectedIndex] = useState(0);`;
const newState = `  const [haltSelectedIndex, setHaltSelectedIndex] = useState(0);
  const [initNewForm, setInitNewForm] = useState<InitNewFormState | null>(null);`;

if (!src.includes(oldState)) {
  console.error("FAIL: could not find haltSelectedIndex state");
  process.exit(1);
}
src = src.replace(oldState, newState);

// ---------------------------------------------------------------------------
// 3. Replace TODO handler with init_new dispatch
// ---------------------------------------------------------------------------
const oldHandler = `        if (key.name === "return") {
          const chosen = activeHaltCard.recovery_options[haltSelectedIndex];
          if (chosen) {
            // TODO Task 5.3/5.4/5.5 — wire real action handlers per option.id
            console.log("halt recovery: not implemented yet:", chosen.id);
          }
          setActiveHaltCard(null);
          setHaltSelectedIndex(0);
          return;
        }`;

const newHandler = `        if (key.name === "return") {
          const chosen = activeHaltCard.recovery_options[haltSelectedIndex];
          if (chosen) {
            if (chosen.id === "init_new") {
              // Task 5.3 — open init-new form; close halt card.
              setInitNewForm(initialInitNewFormState());
              setActiveHaltCard(null);
              setHaltSelectedIndex(0);
              return;
            }
            // TODO Task 5.4/5.5 — wire point_to_existing and other option handlers.
            console.log("halt recovery: not implemented yet:", chosen.id);
          }
          setActiveHaltCard(null);
          setHaltSelectedIndex(0);
          return;
        }`;

if (!src.includes(oldHandler)) {
  console.error("FAIL: could not find TODO halt handler");
  process.exit(1);
}
src = src.replace(oldHandler, newHandler);

// ---------------------------------------------------------------------------
// 4. Add initNewForm keyboard intercept before the activeHaltCard block
// ---------------------------------------------------------------------------
const haltGuard = `      // Halt recovery card intercepts all input until dismissed.
      if (activeHaltCard) {`;

const initFormBlock = `      // Init-new form intercepts all input while open.
      if (initNewForm) {
        if (initNewForm.step === "name") {
          if (isEscapeKey(key)) {
            setInitNewForm(null);
            return;
          }
          if (key.name === "return") {
            const name = initNewForm.nameInput.trim();
            if (!name) {
              setInitNewForm((s) => s ? { ...s, nameError: "Project name cannot be empty." } : s);
              return;
            }
            if (name.includes("/") || name.includes("\\\\") || name.includes("..")) {
              setInitNewForm((s) => s ? { ...s, nameError: "Name cannot contain path separators." } : s);
              return;
            }
            setInitNewForm((s) => s ? { ...s, step: "fe-stack", nameError: null } : s);
            return;
          }
          if (key.name === "backspace" || key.name === "delete") {
            setInitNewForm((s) => s ? { ...s, nameInput: s.nameInput.slice(0, -1), nameError: null } : s);
            return;
          }
          if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
            setInitNewForm((s) => s ? { ...s, nameInput: s.nameInput + key.sequence, nameError: null } : s);
            return;
          }
          return;
        }
        if (initNewForm.step === "fe-stack") {
          if (isEscapeKey(key)) {
            setInitNewForm((s) => s ? { ...s, step: "name" } : s);
            return;
          }
          if (key.name === "up") {
            setInitNewForm((s) =>
              s ? { ...s, feStackIndex: Math.max(0, s.feStackIndex - 1) } : s,
            );
            return;
          }
          if (key.name === "down") {
            setInitNewForm((s) =>
              s ? { ...s, feStackIndex: Math.min(FE_STACK_OPTIONS.length - 1, s.feStackIndex + 1) } : s,
            );
            return;
          }
          if (key.name === "return") {
            const feStack = FE_STACK_OPTIONS[initNewForm.feStackIndex]?.value ?? "react";
            const projectName = initNewForm.nameInput.trim();
            setInitNewForm((s) => s ? { ...s, step: "running" } : s);
            initNewProject({ projectName, feStack })
              .then((result) => {
                setInitNewForm((s) =>
                  s ? { ...s, step: "done", resultMessage: "Created: " + result.projectDir } : s,
                );
              })
              .catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                setInitNewForm((s) => s ? { ...s, step: "error", resultMessage: msg } : s);
              });
            return;
          }
          return;
        }
        // done / error — any key dismisses. running ignores keys.
        if (initNewForm.step === "done" || initNewForm.step === "error") {
          setInitNewForm(null);
          return;
        }
        return;
      }
      // Halt recovery card intercepts all input until dismissed.
      if (activeHaltCard) {`;

if (!src.includes(haltGuard)) {
  console.error("FAIL: could not find Halt recovery card guard");
  process.exit(1);
}
src = src.replace(haltGuard, initFormBlock);

// ---------------------------------------------------------------------------
// 5. Add InitNewFormCard render after the HaltRecoveryCard render block
// ---------------------------------------------------------------------------
const oldRender = `                  {activeHaltCard && (
                    <HaltRecoveryCard
                      halt={activeHaltCard}
                      selectedIndex={haltSelectedIndex}
                      terminalCols={width}
                      theme={t}
                    />
                  )}`;

const newRender = `                  {activeHaltCard && (
                    <HaltRecoveryCard
                      halt={activeHaltCard}
                      selectedIndex={haltSelectedIndex}
                      terminalCols={width}
                      theme={t}
                    />
                  )}
                  {initNewForm && (
                    <InitNewFormCard
                      state={initNewForm}
                      terminalCols={width}
                      theme={t}
                    />
                  )}`;

if (!src.includes(oldRender)) {
  console.error("FAIL: could not find HaltRecoveryCard render block");
  process.exit(1);
}
src = src.replace(oldRender, newRender);

// ---------------------------------------------------------------------------
// Verify all patches applied
// ---------------------------------------------------------------------------
const checks = [
  ["InitNewFormCard import", src.includes("InitNewFormCard")],
  ["initNewProject import", src.includes('from "../scaffold/init-new.js"')],
  ["initNewForm state", src.includes("initNewForm, setInitNewForm")],
  ["init_new handler", src.includes('chosen.id === "init_new"')],
  ["initNewForm key guard", src.includes("Init-new form intercepts")],
  ["InitNewFormCard render", src.includes("{initNewForm && (")],
];

let allOk = true;
for (const [name, ok] of checks) {
  console.log(ok ? `OK: ${name}` : `FAIL: ${name}`);
  if (!ok) allOk = false;
}

if (!allOk) {
  console.error("Some patches failed — NOT writing file.");
  process.exit(1);
}

writeFileSync("src/ui/app.tsx", src, "utf-8");
console.log("Written app.tsx successfully.");
