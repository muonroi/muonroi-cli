const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [log, command, ...args] = process.argv.slice(2);
const output = fs.createWriteStream(log);
const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let tail = "";
const capture = (chunk) => {
  output.write(chunk);
  tail = (tail + chunk.toString()).slice(-5000);
};
child.stdout.on("data", capture);
child.stderr.on("data", capture);
child.on("error", (err) => {
  console.error("Check launch failed:", err.message);
  output.end();
  process.exitCode = 1;
});
child.on("close", (code) =>
  output.end(() => {
    console.log(tail);
    console.log("CHECK_EXIT_CODE=" + code);
    process.exitCode = code ?? 1;
  }),
);
