"""Patch buildModelRoutePrompt to properly serialize context."""
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/home/phila/.experience/experience-core.js"

with open(path, "r") as f:
    lines = f.readlines()

for i in range(len(lines)):
    if "function buildModelRoutePrompt(taskText, context)" in lines[i]:
        j = i + 1
        while j < len(lines) and lines[j].strip() != "}":
            j += 1
        new_fn = [
            "function buildModelRoutePrompt(taskText, context) {\n",
            "  let prompt = CLASSIFY_PROMPT_TEMPLATE.replace('{TASK}', taskText.slice(0, 300));\n",
            "  const parts = [];\n",
            "  if (context && context.domain) parts.push('domain=' + context.domain);\n",
            "  if (context && context.phase) parts.push('phase=' + context.phase);\n",
            "  if (context && context.localRoute && context.localRoute.tier) {\n",
            "    parts.push('local_tier=' + context.localRoute.tier + '(conf:' + (context.localRoute.confidence || 0) + ')');\n",
            "  }\n",
            "  if (parts.length > 0) {\n",
            "    prompt = prompt.replace('{CONTEXT}', parts.join('; '));\n",
            "  } else {\n",
            "    prompt = prompt.replace('Context: {CONTEXT}\\n', '');\n",
            "  }\n",
            "  return prompt;\n",
            "}\n",
        ]
        lines = lines[:i] + new_fn + lines[j+1:]
        print(f"Replaced buildModelRoutePrompt at line {i+1}")
        break
else:
    print("ERROR: function not found")
    sys.exit(1)

with open(path, "w") as f:
    f.writelines(lines)
print("Done")
