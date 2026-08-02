import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { candidateModelToolCatalog } from "../model-tool-contract/catalog";
import {
  renderModelToolContractReview,
  type ContractReviewGovernance,
  type ContractReviewProvenance,
} from "../model-tool-contract/render-review-html";

const root = process.cwd();
const designRelative = candidateModelToolCatalog.sourceDocument;
const catalogRelative = "src/model-tool-contract/catalog.ts";
const outputRelative = "docs/generated/model-tool-contract-review.html";

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function frontMatter(markdown: string): ContractReviewGovernance {
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== "---") throw new Error(`${designRelative} has no YAML front matter.`);
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error(`${designRelative} has unterminated YAML front matter.`);
  const values: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  const required = [
    "document_id",
    "document_kind",
    "lifecycle_stage",
    "scope",
    "responsibility",
    "authority",
    "excludes",
    "maintenance",
  ] as const;
  for (const key of required) {
    if (!values[key]) throw new Error(`${designRelative} front matter is missing ${key}.`);
  }
  return Object.fromEntries(required.map((key) => [key, values[key]])) as unknown as ContractReviewGovernance;
}

function baseRevision(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

const design = read(designRelative);
const catalogSource = read(catalogRelative);
const governance = frontMatter(design);
const provenance: ContractReviewProvenance = {
  baseRevision: baseRevision(),
  catalogSha256: sha256(catalogSource),
  designSha256: sha256(design),
};
const html = renderModelToolContractReview(candidateModelToolCatalog, governance, provenance);
const output = path.join(root, outputRelative);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, html, "utf8");
console.log(`${outputRelative}\n${Buffer.byteLength(html)} bytes\n${provenance.catalogSha256}`);
