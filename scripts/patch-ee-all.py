"""Apply ALL EE patches in one shot."""
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/home/phila/.experience/experience-core.js"

with open(path, "r") as f:
    lines = f.readlines()

changes = 0

# === PATCH 1: Replace CLASSIFY_PROMPT_TEMPLATE (compact, context-aware) ===
start = end = None
for i, line in enumerate(lines):
    if "const CLASSIFY_PROMPT_TEMPLATE" in line:
        start = i
    if start is not None and i > start and line.rstrip().endswith("`;"):
        end = i
        break

if start is not None and end is not None:
    new_tmpl = [
        "const CLASSIFY_PROMPT_TEMPLATE = `Classify this coding task. Reply with ONLY one word: fast, balanced, or premium.\n",
        "\n",
        "fast = single file, simple fix, greeting, explanation, read-only\n",
        "balanced = multi-file, feature, refactor across modules\n",
        "premium = system redesign, architecture, security audit\n",
        "\n",
        "If Context has local_tier with confidence >= 0.6, use it unless Task clearly contradicts.\n",
        "\n",
        "Context: {CONTEXT}\n",
        "Task: {TASK}\n",
        "Complexity:`;\n",
    ]
    lines = lines[:start] + new_tmpl + lines[end+1:]
    changes += 1
    print(f"PATCH 1: Replaced CLASSIFY_PROMPT_TEMPLATE (lines {start+1}-{end+1})")

# === PATCH 2: Replace buildModelRoutePrompt ===
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
        changes += 1
        print(f"PATCH 2: Replaced buildModelRoutePrompt (line {i+1})")
        break

# === PATCH 3: classifyViaBrain — system message + max_tokens 10 ===
# Find the siliconflow branch inside classifyViaBrain (search near the function)
for i in range(len(lines)):
    if "async function classifyViaBrain" in lines[i]:
        # Find the messages line within the next 30 lines
        for j in range(i, min(i+30, len(lines))):
            if "messages: [{ role: 'user', content: prompt }]" in lines[j]:
                lines[j] = lines[j].replace(
                    "messages: [{ role: 'user', content: prompt }]",
                    "messages: [{ role: 'system', content: 'You classify coding task complexity. Reply with exactly one word: fast, balanced, or premium.' }, { role: 'user', content: prompt }]"
                )
                changes += 1
                print(f"PATCH 3a: Added system message at line {j+1}")
                break
        # Find max_tokens: 5 within next 30 lines
        for j in range(i, min(i+30, len(lines))):
            if "max_tokens: 5," in lines[j]:
                lines[j] = lines[j].replace("max_tokens: 5,", "max_tokens: 10,")
                changes += 1
                print(f"PATCH 3b: max_tokens 5→10 at line {j+1}")
                break
        break

with open(path, "w") as f:
    f.writelines(lines)
print(f"\nDone — {changes} patches applied")
