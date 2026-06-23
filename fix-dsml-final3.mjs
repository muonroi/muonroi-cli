import { readFileSync, writeFileSync } from "fs";

const src = readFileSync("src/orchestrator/text-tool-call-detector.ts", "utf8");
const BAR = String.fromCharCode(0xff5c);

// Helper: build regex literal string
function dsmlRegex(inner) {
  // /BAR\s*(?:DSML\s*BAR\s*)?INNER/gi
  return `${BAR}\\s*(?:DSML\\s*${BAR}\\s*)?${inner}`;
}

const replaces = {
  // Line 107
  [`${BAR}\\s*(?:invoke|tool_calls?|parameter)\\b`]: dsmlRegex("(?:invoke|tool_calls?|parameter)\\b"),
  // Lines 108, 176 — had broken \s*\s? pattern
  [`${BAR}\\s*(?:DSML\\s*\\s?)\\s*${BAR}\\s*invoke\\s+name\\s*=\\s*"([^"]+)"`]: dsmlRegex(
    'invoke\\s+name\\s*=\\s*"([^"]+)"',
  ),
  // Line 176 lookahead part (different ending)
  [`(?=${BAR}\\s*invoke\\s|$)`]: `(?=${BAR}\\s*(?:DSML\\s*${BAR}\\s*)?invoke\\s|$)`,
  // Line 177 already correct
};

let fixed = src;
for (const [oldStr, newStr] of Object.entries(replaces)) {
  const count = fixed.split(oldStr).length - 1;
  if (count > 0) {
    fixed = fixed.split(oldStr).join(newStr);
    console.log(`Replaced ${count} occurrence(s) of: ${oldStr.substring(0, 50)}...`);
  } else {
    console.log(`NOT FOUND: ${oldStr.substring(0, 50)}...`);
  }
}

writeFileSync("src/orchestrator/text-tool-call-detector.ts", fixed, "utf8");
console.log("DONE");
