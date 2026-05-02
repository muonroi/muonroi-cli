---
phase: quick
plan: 260502-dvm
type: execute
wave: 1
depends_on: []
files_modified:
  - src/index.ts
  - src/ops/doctor.ts
autonomous: true
requirements: [BYOK-WIZARD, DOCTOR-FIX]
must_haves:
  truths:
    - "First interactive launch without API key triggers welcome wizard"
    - "Wizard saves entered key to user-settings.json via saveUserSettings"
    - "Headless mode still uses requireApiKey() and exits with error (no wizard)"
    - "Doctor key_presence check reads MUONROI_API_KEY env AND user-settings.json"
    - "Doctor report shows CLI version and cloud upsell footer"
  artifacts:
    - path: "src/index.ts"
      provides: "firstRunWizard() function + integration before startInteractive"
      contains: "firstRunWizard"
    - path: "src/ops/doctor.ts"
      provides: "Fixed checkKeyPresence + version + cloud upsell"
      contains: "MUONROI_API_KEY"
  key_links:
    - from: "src/index.ts"
      to: "src/utils/settings.ts"
      via: "saveUserSettings({ apiKey }) in wizard"
      pattern: "saveUserSettings.*apiKey"
    - from: "src/ops/doctor.ts"
      to: "src/utils/settings.ts"
      via: "loadUserSettings().apiKey in key check"
      pattern: "loadUserSettings.*apiKey"
---

<objective>
Add first-run interactive wizard for frictionless BYOK onboarding and fix doctor command key detection.

Purpose: New users launching `muonroi-cli` interactively without a key get a guided setup instead of a cryptic error. Doctor accurately checks the correct env var and settings file.
Output: Modified src/index.ts (wizard), modified src/ops/doctor.ts (fixed checks + upsell).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/index.ts
@src/ops/doctor.ts
@src/utils/settings.ts

<interfaces>
From src/utils/settings.ts:
```typescript
export function getApiKey(): string | undefined;          // MUONROI_API_KEY || user-settings.json
export function saveUserSettings(partial: Partial<UserSettings>): void;
export function loadUserSettings(): UserSettings;
// UserSettings.apiKey?: string
```

From src/index.ts (line ~392):
```typescript
const config = resolveConfig(options);
// config.apiKey: string | undefined
// Line 434-446: startInteractive(config.apiKey, ...) — apiKey can be undefined
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: First-run interactive wizard in index.ts</name>
  <files>src/index.ts</files>
  <action>
Add a `firstRunWizard()` async function near the top of the main action handler (or as a module-level function). Implementation:

1. Create `firstRunWizard(): Promise<string | null>` function:
   - Use `import { createInterface } from "readline"` (Node built-in, already available in Bun)
   - Create readline interface with `input: process.stdin, output: process.stderr` (stderr so wizard output does not pollute piped stdout)
   - Print welcome banner to stderr:
     ```
     Welcome to muonroi-cli!
     
     To get started, you need an API key from Anthropic.
     Get one at: https://console.anthropic.com/settings/keys
     ```
   - Prompt: `"Enter your API key: "` — use a promise wrapper around `rl.question()`
   - If user enters empty string or whitespace → print "No key provided. Set MUONROI_API_KEY env var or run again to enter key." to stderr, close rl, return null
   - If key entered → trim it, close rl, return the trimmed key
   - Wrap in try/catch — if stdin is not a TTY or readline errors, return null silently

2. In the main `.action()` handler, AFTER `const config = resolveConfig(options)` (line ~392) and BEFORE the headless checks (line ~394), add this block that ONLY runs for the interactive path:
   ```typescript
   // First-run wizard: prompt for API key if none configured (interactive only)
   if (!config.apiKey && !options.prompt && !options.verify && process.stdin.isTTY) {
     const wizardKey = await firstRunWizard();
     if (wizardKey) {
       saveUserSettings({ apiKey: wizardKey });
       config.apiKey = wizardKey;
     } else {
       process.exit(1);
     }
   }
   ```
   
   Note: `config` from `resolveConfig` returns a plain object, so `config.apiKey = wizardKey` is valid mutation.

3. Add `saveUserSettings` to the existing import from `"./utils/settings.js"` if not already imported at the action handler scope. Check existing imports — `getApiKey` is likely imported but `saveUserSettings` may need adding.

Key constraints:
- Do NOT touch the headless path — `requireApiKey()` stays for `--prompt` and `--verify`
- Do NOT mask input (readline has no built-in masking; keep it simple)
- The wizard ONLY triggers when: no apiKey in config AND interactive mode AND stdin is TTY
- The existing `if (typeof options.apiKey === "string") saveUserSettings(...)` at line ~316 stays — it handles the `-k` flag path
  </action>
  <verify>
    <automated>cd D:/Personal/Core/muonroi-cli && npx tsc --noEmit src/index.ts 2>&1 | head -20</automated>
  </verify>
  <done>firstRunWizard function exists in index.ts, called before startInteractive when no key and interactive mode, saves key via saveUserSettings, exits cleanly if empty input</done>
</task>

<task type="auto">
  <name>Task 2: Fix doctor key check + add version and cloud upsell</name>
  <files>src/ops/doctor.ts</files>
  <action>
Three changes to src/ops/doctor.ts:

1. **Fix `checkKeyPresence()` (lines 59-84):** Replace the entire function body:
   - Check `process.env.MUONROI_API_KEY` first (not ANTHROPIC_API_KEY)
   - If env var found → return pass with "MUONROI_API_KEY set via env var"
   - Else import and call `loadUserSettings()` from `"../utils/settings.js"` — check `.apiKey`
   - If settings key found → return pass with "API key found in user-settings.json"
   - Remove the keytar/keychain check entirely (dead code — CLI uses user-settings.json now)
   - If neither → return fail with "No API key found (set MUONROI_API_KEY or run muonroi-cli to configure)"
   
   Add import at top: `import { loadUserSettings } from "../utils/settings.js";`

2. **Add CLI version to `formatDoctorReport()`:**
   - Change `formatDoctorReport` signature to accept optional `version?: string` parameter
   - At the top of the output lines, prepend: `"  muonroi-cli v${version || 'unknown'}"`
   - The caller in index.ts already has access to `packageJson.version` — update the call site in index.ts to pass it: `formatDoctorReport(results, packageJson.version)`

3. **Add cloud upsell footer in `formatDoctorReport()`:**
   - After the Summary line, add:
     ```
     ""
     "  For managed Experience Engine: https://muonroi.dev/cloud"
     ```

4. **Update the doctor command call site in src/index.ts** (~line 522 area):
   - Find where `formatDoctorReport(results)` is called
   - Change to `formatDoctorReport(results, packageJson.version)`
  </action>
  <verify>
    <automated>cd D:/Personal/Core/muonroi-cli && npx tsc --noEmit src/ops/doctor.ts 2>&1 | head -20</automated>
  </verify>
  <done>checkKeyPresence checks MUONROI_API_KEY env + loadUserSettings().apiKey (no keytar), formatDoctorReport shows CLI version header and cloud upsell footer, index.ts passes version to formatDoctorReport</done>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit` — no type errors in modified files
2. Manual: `muonroi-cli doctor` shows version header, correct key check source, cloud upsell line
3. Manual: Launch `muonroi-cli` without any key configured — wizard should prompt
</verification>

<success_criteria>
- firstRunWizard prompts on interactive launch when no key exists anywhere
- Entered key persists to ~/.muonroi-cli/user-settings.json
- Headless mode (-p, --verify) still uses requireApiKey error path
- `muonroi-cli doctor` shows MUONROI_API_KEY or user-settings.json as key source
- Doctor report includes CLI version and cloud upsell
</success_criteria>

<output>
After completion, create `.planning/quick/260502-dvm-first-run-wizard-and-doctor-command-for-/260502-dvm-SUMMARY.md`
</output>
