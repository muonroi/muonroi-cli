import { readFileSync, writeFileSync } from "fs";

const _BAR = String.fromCharCode(0xff5c);
let src = readFileSync("src/orchestrator/text-tool-call-detector.ts", "utf8");

// Check each bar char on lines 108,176,177
const lines = src.split("\n");
for (const i of [107, 175, 176]) {
  // 0-based: 107->idx107, 108->idx108, 176->idx176, 177->idx177
  const l = lines[i];
  if (!l) continue;
  // Find all chars around the bar
  for (let j = 0; j < l.length; j++) {
    if (l.charCodeAt(j) === 0xff5c || l.charCodeAt(j) === 0x2223 || l.charCodeAt(j) === 0x7c) {
      process.stderr.write(`Line ${i + 1} col ${j}: U+${l.charCodeAt(j).toString(16).toUpperCase()} '${l[j]}'\n`);
    }
  }
}

// Line 107: DSML_WRAPPER_RE - replace old format
const old107 = "/│\\s*(?:invoke|tool_calls?|parameter)\\b/i";
const new107 = "/│\\s*(?:DSML\\s*│\\s*)?(?:invoke|tool_calls?|parameter)\\b/i";
if (src.includes(old107)) {
  src = src.replace(old107, new107);
  console.log("107 OK");
} else {
  console.log("107 FAIL - exact chars around DSML_WRAPPER_RE:");
  const idx = src.indexOf("DSML_WRAPPER_RE");
  console.log(JSON.stringify(src.substring(idx, idx + 90)));
}

// Line 108: DSML_INVOKE_NAME_RE
const old108 = '/│\\s*(?:DSML\\s*\\s?)\\s*│\\s*invoke\\s+name\\s*=\\s*"([^"]+)"/i';
const new108 = '/│\\s*(?:DSML\\s*│\\s*)?invoke\\s+name\\s*=\\s*"([^"]+)"/i';
if (src.includes(old108)) {
  src = src.replace(old108, new108);
  console.log("108 OK");
} else {
  console.log("108 FAIL. Bar chars in line:");
  const idx = src.indexOf("DSML_INVOKE_NAME_RE");
  console.log(JSON.stringify(src.substring(idx, idx + 90)));
}

// Line 176: DSML_INVOKE_BLOCK_RE
const old176 = '/│\\s*(?:DSML\\s*\\s?)\\s*│\\s*invoke\\s+name\\s*=\\s*"([^"]+)"([\\s\\S]*?)(?=│\\s*invoke\\s|$)/gi';
const new176 =
  '/│\\s*(?:DSML\\s*│\\s*)?invoke\\s+name\\s*=\\s*"([^"]+)"([\\s\\S]*?)(?=│\\s*(?:DSML\\s*│\\s*)?invoke\\s|$)/gi';
if (src.includes(old176)) {
  src = src.replace(old176, new176);
  console.log("176 OK");
} else {
  console.log("176 FAIL");
  const idx = src.indexOf("DSML_INVOKE_BLOCK_RE");
  console.log(JSON.stringify(src.substring(idx, idx + 120)));
}

// Line 177: DSML_PARAM_RE
const old177 =
  '/│\\s*(?:DSML\\s*\\s?)\\s*│\\s*parameter\\s+name\\s*=\\s*"([^"]+)"[^>]*>([\\s\\S]*?)<\\/?│\\s*parameter/gi';
const new177 =
  '/│\\s*(?:DSML\\s*│\\s*)?parameter\\s+name\\s*=\\s*"([^"]+)"[^>]*>([\\s\\S]*?)<\\/?│\\s*(?:DSML\\s*│\\s*)?parameter/gi';
if (src.includes(old177)) {
  src = src.replace(old177, new177);
  console.log("177 OK");
} else {
  console.log("177 FAIL");
  const idx = src.indexOf("DSML_PARAM_RE");
  console.log(JSON.stringify(src.substring(idx, idx + 120)));
}

writeFileSync("src/orchestrator/text-tool-call-detector.ts", src, "utf8");
console.log("DONE");
