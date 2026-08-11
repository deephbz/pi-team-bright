const fs = require("node:fs");
const { spawn } = require("node:child_process");

const pidFile = process.argv[2];
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "inherit" });
fs.writeFileSync(pidFile, String(descendant.pid));
setInterval(() => {}, 1_000);
