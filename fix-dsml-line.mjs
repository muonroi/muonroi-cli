import { readFileSync, writeFileSync } from "fs";

const src = readFileSync("src/orchestrator/text-tool-call-detector.ts", "utf8");
const lines = src.split("\n");
const BAR = String.fromCharCode(0xff5c);

// Line 107 (idx 106): DSML_WRAPPER_RE
const l107 = lines[106];
const idx107 = l107.indexOf("const DSML_WRAPPER_RE");
if (idx107 >= 0) {
  const startQ = l107.indexOf("/", idx107);
  const endQ = l107.lastIndexOf("/i");
  const oldBody = l107.substring(startQ, endQ + 2);
  const newBody = `/${BAR}\\s*(?:DSML\\s*${BAR}\\s*)?(?:invoke|tool_calls?|parameter)\\b/i`;
  lines[106] = l107.replace(oldBody, newBody);
  console.log(`L107: ${lines[106] === l107 ? "UNCHANGED" : "OK"}`);
} else console.log("L107 not found");

// Line 108 (idx 107): DSML_INVOKE_NAME_RE
const l108 = lines[107];
const idx108 = l108.indexOf("const DSML_INVOKE_NAME_RE");
if (idx108 >= 0) {
  const startQ = l108.indexOf("/", idx108);
  const endQ = l108.lastIndexOf("/i");
  const oldBody = l108.substring(startQ, endQ + 2);
  const newBody = `/${BAR}\\s*(?:DSML\\s*${BAR}\\s*)?invoke\\s+name\\s*=\\s*"([^"]+)"/i`;
  lines[107] = l108.replace(oldBody, newBody);
  console.log(`L108: ${lines[107] === l108 ? "UNCHANGED" : "OK"}`);
} else console.log("L108 not found");

// Line 176 (idx 175): DSML_INVOKE_BLOCK_RE
const l176 = lines[175];
const idx176 = l176.indexOf("const DSML_INVOKE_BLOCK_RE");
if (idx176 >= 0) {
  const startQ = l176.indexOf("/", idx176);
  const endQ = l176.lastIndexOf("/gi");
  const oldBody = l176.substring(startQ, endQ + 3);
  const newBody = `/${BAR}\\s*(?:DSML\\s*${BAR}\\s*)?invoke\\s+name\\s*=\\s*"([^"]+)"([\\s\\S]*?)(?=${BAR}\\s*(?:DSML\\s*${BAR}\\s*)?invoke\\s|$)/gi`;
  lines[175] = l176.replace(oldBody, newBody);
  console.log(`L176: ${lines[175] === l176 ? "UNCHANGED" : "OK"}`);
} else console.log("L176 not found");

// Line 177 (idx 176): DSML_PARAM_RE
const l177 = lines[176];
const idx177 = l177.indexOf("const DSML_PARAM_RE");
if (idx177 >= 0) {
  const startQ = l177.indexOf("/", idx177);
  const endQ = l177.lastIndexOf("/gi");
  const oldBody = l177.substring(startQ, endQ + 3);
  const newBody = `/${BAR}\\s*(?:DSML\\s*${BAR}\\s*)?parameter\\s+name\\s*=\\s*"([^"]+)"[^>]*>([\\s\\S]*?)<\\/?${BAR}\\s*(?:DSML\\s*${BAR}\\s*)?parameter/gi`;
  lines[176] = l177.replace(oldBody, newBody);
  console.log(`L177: ${lines[176] === l176 ? "UNCHANGED" : "OK"}`);
} else console.log("L177 not found");

writeFileSync("src/orchestrator/text-tool-call-detector.ts", lines.join("\n"), "utf8");
console.log("DONE");
