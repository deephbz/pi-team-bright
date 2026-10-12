import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface DirectHostCall { file: string; line: number; primitive: string }

/** Static seam inventory. This reports candidates; it does not certify runtime reachability. */
export function directHostCalls(root: string): DirectHostCall[] {
  const calls: DirectHostCall[] = [];
  const files = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "env" ? [] : files(file);
    return file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".d.ts") ? [file] : [];
  });
  const primitives = /^(?:Date\.now|Math\.random|performance\.now|Atomics\.wait|AbortSignal\.timeout|(?:crypto\.)?(?:randomUUID|randomBytes)|(?:os\.)?(?:homedir|tmpdir)|(?:fs\.)?(?:watch|watchFile)|(?:child_process\.)?(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)|(?:globalThis\.)?(?:setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate)|process\.(?:cwd|kill|exit|hrtime|uptime))$/;
  const properties = /^(?:process\.(?:env|pid|argv|execPath|platform)|fs\.promises)$/;
  for (const file of [...files(path.join(root, "src")), ...files(path.join(root, "extensions"))].sort()) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      let primitive: string | undefined;
      if (ts.isCallExpression(node) && primitives.test(node.expression.getText(source))) primitive = node.expression.getText(source);
      if (ts.isPropertyAccessExpression(node) && properties.test(node.getText(source))) primitive = node.getText(source);
      if (ts.isNewExpression(node) && node.expression.getText(source) === "Date" && !node.arguments?.length) primitive = "new Date()";
      if (primitive) calls.push({ file: path.relative(root, file), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, primitive });
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return calls;
}

if (require.main === module) console.log(JSON.stringify(directHostCalls(process.cwd()), null, 2));
