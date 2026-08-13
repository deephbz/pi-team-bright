import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function testFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return testFiles(file);
    return /(?:\.test\.ts|suite\.test\.ts)$/.test(entry.name) ? [file] : [];
  });
}

function productionFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return productionFiles(file);
    return /\.ts$/.test(entry.name) && !/(?:\.test\.ts|suite\.test\.ts)$/.test(entry.name) ? [file] : [];
  });
}

function taskUtilityImports(source: ts.SourceFile): { names: Map<string, string>; namespaces: Set<string> } {
  const names = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!/(?:^|\/)utils\/tasks$|^\.\/tasks$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else for (const element of bindings.elements) names.set(element.name.text, element.propertyName?.text ?? element.name.text);
  }
  return { names, namespaces };
}

function productionAdapterUses(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const location = (node: ts.Node, rule: string) =>
    violations.push(`${rule} ${path.relative(process.cwd(), file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "BeadsTaskAdapter") {
      const argumentsLength = node.arguments?.length ?? 0;
      const authorityArgument = node.arguments?.[2];
      if (argumentsLength < 3 || argumentsLength > 4 || (authorityArgument && ts.isIdentifier(authorityArgument) && authorityArgument.text === "undefined")) {
        location(node, "BeadsTaskAdapter has implicit authority");
      }
      if (path.relative(process.cwd(), file) !== "src/model-tool-contract/beads-task-adapter.ts") {
        location(node, "BeadsTaskAdapter consumer construction is forbidden");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function implicitReadAuthorityUses(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const omissions: string[] = [];
  const taskUtilities = taskUtilityImports(source);
  const location = (node: ts.Node, rule: string) =>
    omissions.push(`${rule} ${path.relative(process.cwd(), file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const argumentsLength = node.arguments?.length ?? 0;
      const authorityArgument = node.arguments?.[2];
      if (node.expression.text === "BeadsTaskAdapter" && (
        argumentsLength < 3 || (authorityArgument !== undefined && ts.isIdentifier(authorityArgument) && authorityArgument.text === "undefined")
      )) location(node, "BeadsTaskAdapter lacks authority");
      if ((node.expression.text === "DurableAssignedWorkGuard" || node.expression.text === "DurableCoordinationTaskStateDeliveryQuery") && argumentsLength === 0) {
        location(node, `${node.expression.text} lacks factory`);
      }
      if ((node.expression.text === "BeadsTaskReconciliationQuery" || node.expression.text === "DurableModelToolTaskApplication") && argumentsLength === 1) {
        location(node, `${node.expression.text} lacks factory`);
      }
      if (node.expression.text === "DurableModelToolCoordinationApplication" && argumentsLength < 2) {
        location(node, "DurableModelToolCoordinationApplication lacks service");
      }
      if (node.expression.text === "DurableModelToolTeamPort" && argumentsLength < 5) {
        location(node, "DurableModelToolTeamPort lacks explicit read composition");
      }
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "createDurableCoordinationQueries" && node.arguments.length === 0) {
        location(node, "createDurableCoordinationQueries lacks factory");
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "readWorkerRunObservation" && node.arguments.length < 3) {
        location(node, "readWorkerRunObservation lacks query bundle");
      }
      let utilityName: string | undefined;
      if (ts.isIdentifier(node.expression)) utilityName = taskUtilities.names.get(node.expression.text);
      else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && taskUtilities.namespaces.has(node.expression.expression.text)) {
        utilityName = node.expression.name.text;
      }
      const factoryPosition = utilityName === "listTasks" ? 2 : 3;
      if (utilityName && ["readTask", "readTasks", "listTasks", "listTasksWithVersions"].includes(utilityName) && node.arguments.length < factoryPosition) {
        location(node, `utils/tasks ${utilityName} lacks factory`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return omissions;
}

describe("Task read fixture inventory", () => {
  it("keeps raw Task reads and Team configuration behind their owned production ports", () => {
    const authorityAdapter = fs.readFileSync(path.join(process.cwd(), "src/model-tool-contract/beads-authority-adapter.ts"), "utf8");
    const taskAdapter = fs.readFileSync(path.join(process.cwd(), "src/model-tool-contract/beads-task-adapter.ts"), "utf8");
    const durableRead = fs.readFileSync(path.join(process.cwd(), "src/adapters/durable-task-authority-read.ts"), "utf8");
    const durableReadTeam = fs.readFileSync(path.join(process.cwd(), "src/adapters/durable-task-authority-read-team.ts"), "utf8");
    const taskContracts = fs.readFileSync(path.join(process.cwd(), "src/task-authority/contracts.ts"), "utf8");
    expect(authorityAdapter).not.toMatch(/async function storeFor\(/);
    expect(authorityAdapter).not.toMatch(/export async function (readTaskAuthorityRecordEnvelope|readTaskAuthorityRecordEnvelopes|listTaskIds)\(/);
    expect(taskAdapter).not.toMatch(/import\s*\{[^}]*\b(readTaskAuthorityRecordEnvelope|readTaskAuthorityRecordEnvelopes|listTaskIds)\b[^}]*\}\s*from "\.\/beads-authority-adapter"/s);
    expect(taskAdapter).not.toMatch(/export async function readTaskOwnerTransitionEvidence\(/);
    expect(taskAdapter).not.toMatch(/\b(readMany|list)\?\s*\(/);
    expect(taskAdapter).not.toMatch(/TaskAuthorityReadPort\s*=/);
    expect(taskAdapter).not.toMatch(/authority:\s*TaskAdapterAuthority\s*=/);
    expect(taskAdapter).not.toMatch(/Promise\.all\(taskIds\.map\(\(taskId\) => this\.authority\.read\(taskId\)\)\)/);
    expect(taskAdapter).not.toMatch(/listTaskIds\(this\.teamName\)/);
    expect(durableRead).not.toContain('from "../utils/teams"');
    expect(taskContracts).not.toMatch(/from\s+["'][^"']*(?:\/utils\/|utils\/beads)[^"']*["']/);
    expect(durableReadTeam).toMatch(/import \{ readConfig \} from "\.\.\/utils\/teams"/);
  });

  it("allows direct production Task adapter construction only inside its two factories", () => {
    const roots = ["extensions", "src", "scripts"].map((root) => path.join(process.cwd(), root));
    const files = roots.flatMap((root) => fs.existsSync(root) ? productionFiles(root) : []);
    const violations = files.flatMap(productionAdapterUses);
    const omissions = files.flatMap(implicitReadAuthorityUses);
    const adapterSource = path.join(process.cwd(), "src/model-tool-contract/beads-task-adapter.ts");
    const source = ts.createSourceFile(adapterSource, fs.readFileSync(adapterSource, "utf8"), ts.ScriptTarget.Latest, true);
    const factoryConstructions: string[] = [];
    const count = (node: ts.Node, enclosingFunction?: string) => {
      const functionName = ts.isFunctionDeclaration(node) && node.name ? node.name.text : enclosingFunction;
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "BeadsTaskAdapter") {
        factoryConstructions.push(functionName ?? "<anonymous>");
      }
      ts.forEachChild(node, (child) => count(child, functionName));
    };
    count(source);
    expect(violations).toEqual([]);
    expect(omissions).toEqual([]);
    expect(factoryConstructions).toEqual([
      "createReadOnlyBeadsTaskAdapterFactory",
      "createPublishingBeadsTaskAdapterFactory",
    ]);
  });

  it("keeps the hydration benchmark on the durable read port", () => {
    const benchmark = ts.createSourceFile(
      "scripts/task-hydration-benchmark.ts",
      fs.readFileSync(path.join(process.cwd(), "scripts/task-hydration-benchmark.ts"), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const importsRawAuthority = benchmark.statements.some((statement) =>
      ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text.includes("beads-authority-adapter"));
    expect(importsRawAuthority).toBe(false);
  });

  it("requires explicit read authority for every direct Task adapter test construction", () => {
    const roots = [
      path.join(process.cwd(), "src"),
      path.join(process.cwd(), "test"),
      path.join(process.cwd(), "scripts", "tool-result-qa"),
    ];
    const omissions = roots.flatMap((root) => fs.existsSync(root)
      ? testFiles(root).flatMap(implicitReadAuthorityUses)
      : []);
    expect(omissions).toEqual([]);
  });
});
