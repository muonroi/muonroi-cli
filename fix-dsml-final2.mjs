import { readFileSync, writeFileSync } from "fs";

const src = readFileSync("src/orchestrator/text-tool-call-detector.ts", "utf8");
const BAR = String.fromCharCode(0xff5c);

// Build correct regexes
const wrapperRE = `${BAR}\\s*(?:DSML\\s*${BAR}\\s*)?(?:invoke|tool_calls?|parameter)\\b`;
const invokeNameRE = `${BAR}\\s*(?:DSML\\s*${BAR}\\s*)?invoke\\s+name\\s*=\\s*"([^"]+)"`;
const invokeBlockRE = `${BAR}\\s*(?:DSML\\s*${BAR}\\s*)?invoke\\s+name\\s*=\\s*"([^"]+)"([\\s\\S]*?)(?=${BAR}\\s*(?:DSML\\s*${BAR}\\s*)?invoke\\s|$)`;
const paramRE = `${BAR}\\s*(?:DSML\\s*${BAR}\\s*)?parameter\\s+name\\s*=\\s*"([^"]+)"[^>]*>([\\s\\S]*?)<\\/?${BAR}\\s*(?:DSML\\s*${BAR}\\s*)?parameter`;

// Replace each using regex on the JS string content
function replaceLine(keyword, newRegexBody) {
  // Find `const KEYWORD = /<body>/i;` (or /gi)
  const pat = new RegExp(`(const ${keyword} = /).+?(/[ig]*;)`);
  const m = src.match(pat);
  if (m) {
    const before = m[0];
    const after = m[1] + newRegexBody + m[2];
    console.log(`${keyword}: ${before.substring(0, 80)}... -> ${after.substring(0, 80)}...`);
    return src.replace(before, after);
  }
  console.log(`${keyword}: NOT FOUND`);
  return src;
}

let fixed = replaceLine("DSML_WRAPPER_RE", wrapperRE);
fixed = replaceLine("DSML_INVOKE_NAME_RE", invokeNameRE);
fixed = replaceLine("DSML_INVOKE_BLOCK_RE", invokeBlockRE);
fixed = replaceLine("DSML_PARAM_RE", paramRE);

writeFileSync("src/orchestrator/text-tool-call-detector.ts", fixed, "utf8");
console.log("DONE");
