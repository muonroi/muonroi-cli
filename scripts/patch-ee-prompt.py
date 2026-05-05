"""Patch CLASSIFY_PROMPT_TEMPLATE to weight context properly."""
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/home/phila/.experience/experience-core.js"

with open(path, "r") as f:
    lines = f.readlines()

# Find and replace the entire CLASSIFY_PROMPT_TEMPLATE
start_idx = None
end_idx = None
for i, line in enumerate(lines):
    if "const CLASSIFY_PROMPT_TEMPLATE" in line:
        start_idx = i
    if start_idx is not None and i > start_idx and "`;" in line:
        end_idx = i
        break

if start_idx is None or end_idx is None:
    print("ERROR: CLASSIFY_PROMPT_TEMPLATE not found")
    sys.exit(1)

new_template = '''const CLASSIFY_PROMPT_TEMPLATE = `Classify the complexity of this coding task. Reply with ONLY one word: fast, balanced, or premium.

fast: single file, simple fix, greeting, explanation, read-only command
balanced: multi-file change, feature implementation, refactoring across modules
premium: system redesign, architecture change, security audit, multi-service coordination

IMPORTANT: If Context includes local_tier, use it as strong signal — the local classifier already analyzed conversation history. Only override if the task text clearly contradicts it.

Context: {CONTEXT}
Task: {TASK}
Complexity:`;
'''

lines = lines[:start_idx] + [new_template] + lines[end_idx+1:]
print(f"Replaced template at lines {start_idx+1}-{end_idx+1}")

with open(path, "w") as f:
    f.writelines(lines)
print("Done")
