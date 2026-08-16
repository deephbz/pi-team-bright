/* Verify the packed public artifact, not ts-node's source-loader behavior. */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = require(path.join(root, "package.json"));
const packageName = manifest.name;
if (manifest.author !== "deephbz") throw new Error("package author must be deephbz");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-bright-package-"));
let tarball;
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }))[0];
  tarball = path.join(root, packed.filename);
  execFileSync("npm", ["init", "-y"], { cwd: work, stdio: "ignore" });
  execFileSync("npm", ["install", "--ignore-scripts", tarball], { cwd: work, stdio: "ignore" });
  const probe = `const o=require('${packageName}/observation'); if(o.OBSERVATION_SCHEMA !== 'pi-teams-observation/1' || typeof o.readObservationSnapshot !== 'function') process.exit(1); o.readObservationSnapshot({teamsRoot: process.cwd()}).then(x => { if (!x.schema) process.exit(1); });`;
  execFileSync(process.execPath, ["-e", probe], { cwd: work, stdio: "inherit" });
  fs.writeFileSync(path.join(work, "probe.ts"), `import { OBSERVATION_SCHEMA, readObservationSnapshot } from '${packageName}/observation'; void readObservationSnapshot; const schema: 'pi-teams-observation/1' = OBSERVATION_SCHEMA;\n`);
  execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["--noEmit", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ESNext", "probe.ts"], { cwd: work, stdio: "inherit" });
  console.log("packed observation package probe passed");
} finally {
  if (tarball) fs.rmSync(tarball, { force: true });
  fs.rmSync(work, { recursive: true, force: true });
}
