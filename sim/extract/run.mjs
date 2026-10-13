import { createServer } from "vite";
import path from "node:path";

// Vite loads the shared tool schemas, including their ESM-only dependencies.
const server = await createServer({ configFile: false, logLevel: "silent", server: { middlewareMode: true }, appType: "custom",
  plugins: [{ name: "extractor-cjs-coordinates", transform(code, id) {
    if (!/\/sim\/extract\/(index|validate)\.ts$/.test(id)) return;
    return { code: `const __dirname = ${JSON.stringify(path.dirname(id))};\n${code.replace("if (require.main === module)", "if (false)")}`, map: null };
  } }],
});
try {
  const { extractCorpus } = await server.ssrLoadModule("/sim/extract/index.ts");
  if (process.argv.includes("--check")) console.log("Extractor loaded; no source reads requested.");
  else console.log(JSON.stringify(extractCorpus(), null, 2));
} catch {
  console.error("Trace extraction failed; no source details were printed.");
  process.exitCode = 1;
} finally {
  await server.close();
}
