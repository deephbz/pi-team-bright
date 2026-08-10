import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const mutationArity = {
  createTask: 6,
  applySemanticTaskUpdate: 6,
  mutateTaskLink: 6,
  createPublishingBeadsTaskAdapterFactory: 2,
} as const;

type MutationName = keyof typeof mutationArity;

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(candidate) : [candidate];
  }).filter((candidate) => candidate.endsWith(".ts"));
}

function isMutationName(value: string): value is MutationName {
  return value in mutationArity;
}

function importedMutationNames(source: ts.SourceFile): Map<string, MutationName> {
  const names = new Map<string, MutationName>();
  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    if (!/beads-(authority|task)-adapter$/.test(node.moduleSpecifier.text)) return;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const item of bindings.elements) {
      const imported = item.propertyName?.text ?? item.name.text;
      if (isMutationName(imported)) names.set(item.name.text, imported);
    }
  });
  return names;
}

function callName(node: ts.CallExpression, imported: Map<string, MutationName>): MutationName | undefined {
  if (ts.isIdentifier(node.expression)) return imported.get(node.expression.text);
  // Tool-result QA imports this adapter dynamically. No other selected caller
  // uses a qualified mutation function.
  if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "applySemanticTaskUpdate") {
    return "applySemanticTaskUpdate";
  }
  return undefined;
}

describe("test and QA Task mutation port inventory", () => {
  it("passes an explicit TaskAuthorityTeamPort to every selected mutation caller", () => {
    const root = process.cwd();
    const files = [
      ...sourceFiles(path.join(root, "src")).filter((file) => file.endsWith(".test.ts")),
      ...sourceFiles(path.join(root, "test")),
      ...sourceFiles(path.join(root, "scripts", "tool-result-qa")),
    ];
    const omissions: string[] = [];
    for (const file of files) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const imported = importedMutationNames(source);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const name = callName(node, imported);
          if (name && !node.arguments.some(ts.isSpreadElement) && node.arguments.length < mutationArity[name]) {
            const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            omissions.push(`${path.relative(root, file)}:${line} ${name} needs explicit TaskAuthorityTeamPort`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(omissions).toEqual([]);
  });
});
