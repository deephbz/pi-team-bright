import fs from "node:fs";
import path from "node:path";

/** Write JSON fixtures directly; production persistence behavior belongs in atomic-json. */
export function writeJsonFixture(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
