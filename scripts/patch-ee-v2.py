"""Patch experience-core.js — line-based approach."""
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/home/phila/.experience/experience-core.js"

with open(path, "r") as f:
    lines = f.readlines()

changes = 0

# 1. Add Context: {CONTEXT} before "Task: {TASK}" in CLASSIFY_PROMPT_TEMPLATE
# Find the line with "Task: {TASK}" that's inside the template (near line 3366)
for i in range(3340, 3380):
    if i < len(lines) and "Task: {TASK}" in lines[i] and "Complexity:" in lines[i+1] if i+1 < len(lines) else False:
        if "{CONTEXT}" not in lines[i] and "{CONTEXT}" not in (lines[i-1] if i > 0 else ""):
            lines.insert(i, "Context: {CONTEXT}\n")
            changes += 1
            print(f"Inserted CONTEXT at line {i+1}")
        break

# Re-find buildModelRoutePrompt after potential insert
for i in range(len(lines)):
    if "function buildModelRoutePrompt(taskText, context)" in lines[i]:
        # Find closing brace
        j = i + 1
        while j < len(lines) and not (lines[j].strip() == "}"):
            j += 1
        # Replace lines i through j inclusive
        new_lines = [
            "function buildModelRoutePrompt(taskText, context) {\n",
            "  let prompt = CLASSIFY_PROMPT_TEMPLATE.replace('{TASK}', taskText.slice(0, 300));\n",
            "  const parts = [];\n",
            "  if (context && context.domain) parts.push('domain=' + context.domain);\n",
            "  if (context && context.phase) parts.push('phase=' + context.phase);\n",
            "  if (context && context.localRoute) parts.push('local_tier=' + context.localRoute.tier);\n",
            "  if (parts.length > 0) {\n",
            "    prompt = prompt.replace('{CONTEXT}', parts.join('; '));\n",
            "  } else {\n",
            "    prompt = prompt.replace('Context: {CONTEXT}\\n', '');\n",
            "  }\n",
            "  return prompt;\n",
            "}\n",
        ]
        lines = lines[:i] + new_lines + lines[j+1:]
        changes += 1
        print(f"Replaced buildModelRoutePrompt at line {i+1}")
        break

with open(path, "w") as f:
    f.writelines(lines)
print(f"Done — {changes} changes")
