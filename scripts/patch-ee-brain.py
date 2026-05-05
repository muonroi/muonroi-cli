"""Patch experience-core.js to add context to brain routing prompt."""
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/home/phila/.experience/experience-core.js"

with open(path, "r") as f:
    code = f.read()

changes = 0

# 1. Add "Context: {CONTEXT}\n" before "Task: {TASK}" in CLASSIFY_PROMPT_TEMPLATE
old_task = "Task: {TASK}\nComplexity:"
new_task = "Context: {CONTEXT}\nTask: {TASK}\nComplexity:"
if "{CONTEXT}" not in code:
    code = code.replace(old_task, new_task)
    changes += 1
    print("Added {CONTEXT} to template")

# 2. Replace buildModelRoutePrompt to inject context signals
old_fn = "function buildModelRoutePrompt(taskText, context) {\n  return CLASSIFY_PROMPT_TEMPLATE.replace('{TASK}', taskText.slice(0, 300));\n}"

new_fn = """function buildModelRoutePrompt(taskText, context) {
  let prompt = CLASSIFY_PROMPT_TEMPLATE.replace('{TASK}', taskText.slice(0, 300));
  const parts = [];
  if (context && context.domain) parts.push('domain=' + context.domain);
  if (context && context.phase) parts.push('phase=' + context.phase);
  if (context && context.localRoute) parts.push('local_tier=' + context.localRoute.tier);
  if (parts.length > 0) {
    prompt = prompt.replace('{CONTEXT}', parts.join('; '));
  } else {
    prompt = prompt.replace('Context: {CONTEXT}\\n', '');
  }
  return prompt;
}"""

if old_fn in code:
    code = code.replace(old_fn, new_fn)
    changes += 1
    print("Replaced buildModelRoutePrompt")
else:
    print("WARN: buildModelRoutePrompt not found (may already be patched)")

with open(path, "w") as f:
    f.write(code)
print(f"Done — {changes} changes")
