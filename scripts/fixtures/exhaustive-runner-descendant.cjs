const fs = require("node:fs");
const { spawn } = require("node:child_process");

const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
fs.writeFileSync(process.argv[2], String(descendant.pid));
setInterval(() => {}, 1_000);
