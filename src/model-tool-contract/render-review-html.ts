import { MODEL_TOOL_CANDIDATE_LIMITS, type CandidateModelToolCatalog } from "./catalog";
import { serializeCandidateToolResult, type CandidateProjectedTool } from "./result-projection";

export interface ContractReviewGovernance {
  document_id: string;
  document_kind: string;
  lifecycle_stage: string;
  scope: string;
  responsibility: string;
  authority: string;
  excludes: string;
  maintenance: string;
}

export interface ContractReviewProvenance {
  baseRevision: string;
  catalogSha256: string;
  designSha256: string;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function json(value: unknown, pretty = true): string {
  return escapeHtml(JSON.stringify(value, null, pretty ? 2 : 0));
}

function list(items: readonly string[]): string {
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function schemaType(schema: Record<string, unknown>): string {
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.enum)) return "enum";
  if (schema.const !== undefined) return "literal";
  if (Array.isArray(schema.anyOf)) return "union";
  return "schema";
}

function parameterRows(schema: Record<string, any>): string {
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties || {}).map(([name, raw]) => {
    const property = raw as Record<string, any>;
    const constraint = Array.isArray(property.enum)
      ? property.enum.join(" | ")
      : [
          property.minLength !== undefined ? `min ${property.minLength}` : "",
          property.maxLength !== undefined ? `max ${property.maxLength}` : "",
        ].filter(Boolean).join(", ");
    return `<tr>
      <td><code>${escapeHtml(name)}</code></td>
      <td>${required.has(name) ? '<span class="required">required</span>' : "optional"}</td>
      <td>${escapeHtml(schemaType(property))}</td>
      <td>${escapeHtml(constraint || "—")}</td>
      <td>${escapeHtml(property.description || "")}</td>
    </tr>`;
  }).join("");
}

function resultSummary(schema: Record<string, any>): string {
  const variants = Array.isArray(schema.anyOf) ? schema.anyOf : [schema];
  return variants.map((variant: Record<string, any>) => {
    const kind = variant.properties?.kind?.const || "result";
    const fields = Object.keys(variant.properties || {}).filter((field) => field !== "kind");
    return `<article class="result-variant">
      <h4><code>${escapeHtml(kind)}</code></h4>
      <p>${fields.map((field) => `<code>${escapeHtml(field)}</code>`).join(" · ")}</p>
    </article>`;
  }).join("");
}

function scenarioHtml(scenario: CandidateModelToolCatalog["scenarios"][number], index: number): string {
  const modelContent = serializeCandidateToolResult(scenario.tool as CandidateProjectedTool, scenario.result);
  return `<article class="scenario" id="scenario-${escapeHtml(scenario.id)}">
    <header>
      <span class="eyebrow">Scenario ${index + 1} · ${escapeHtml(scenario.tool)}</span>
      <h3>${escapeHtml(scenario.title)}</h3>
    </header>
    <div class="scenario-grid">
      <section><h4>Situation</h4><p>${escapeHtml(scenario.situation)}</p></section>
      <section><h4>Leader decision</h4><p>${escapeHtml(scenario.leaderDecision)}</p></section>
    </div>
    <div class="code-grid">
      <section><h4>Model call</h4><pre>${json(scenario.call)}</pre></section>
      <section><h4>Default model return</h4><pre class="model-return">${escapeHtml(modelContent)}</pre></section>
    </div>
    <details><summary>Same named semantic JSON, formatted for review</summary><pre>${json(scenario.result)}</pre></details>
    <section class="reasoning"><h4>Expected reasoning</h4>${list(scenario.expectedReasoning)}</section>
    <section class="review"><h4>Your review</h4>${list(scenario.reviewQuestions)}</section>
  </article>`;
}

function governanceHtml(governance: ContractReviewGovernance): string {
  const entries: Array<[string, string]> = [
    ["Scope", governance.scope],
    ["Responsibility", governance.responsibility],
    ["Authority", governance.authority],
    ["Excludes", governance.excludes],
    ["Maintenance", governance.maintenance],
  ];
  return `<section class="governance" id="scope">
    <div class="section-heading"><span class="eyebrow">Document contract</span><h2>Scope and responsibility</h2></div>
    <dl>${entries.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
  </section>`;
}

function toolSignature(name: string): string {
  if (name === "team_create") return "team_create({ name, purpose })";
  if (name === "team_sync") return "team_sync({ view })";
  if (name === "task_create") return "task_create({ tasks })";
  if (name === "task_read") return "task_read({ task_ids })";
  if (name === "task_update") return "task_update({ updates })";
  if (name === "worker_stop") return "worker_stop({ worker })";
  if (name === "team_shutdown") return "team_shutdown({ })";
  if (name === "task_link") return "task_link({ task_id, relation, target_id, action, expected_version })";
  if (name === "alert_send") return "alert_send({ to, kind, text, task_id, task_version })";
  return "ensure_worker({ name, scope })";
}

function toolHtml(tool: CandidateModelToolCatalog["tools"][number], index: number, toolCount: number): string {
  return `<article class="tool-card" id="tool-${escapeHtml(tool.name)}">
    <span class="eyebrow">Candidate function ${index + 1} of ${escapeHtml(toolCount)}</span>
    <h3><code>${escapeHtml(tool.name)}</code></h3>
    <p>${escapeHtml(tool.responsibility)}</p>
    <div class="call-signature">${escapeHtml(toolSignature(tool.name))}</div>
    <div class="two-col">
      <section><h4>Use it for</h4>${list(tool.commonUseCases)}</section>
      <section><h4>Do not use it for</h4>${list(tool.whenNotToUse)}</section>
    </div>
    <h4>Arguments</h4>
    <table><thead><tr><th>Field</th><th>Presence</th><th>Type</th><th>Constraint</th><th>Meaning</th></tr></thead><tbody>${parameterRows(tool.parameters as unknown as Record<string, any>)}</tbody></table>
    <h4>Semantic JSON results</h4>
    <div class="result-grid">${resultSummary(tool.result as unknown as Record<string, any>)}</div>
    <h4>State effects</h4>${list(tool.sideEffects)}
  </article>`;
}

export function renderModelToolContractReview(
  catalog: CandidateModelToolCatalog,
  governance: ContractReviewGovernance,
  provenance: ContractReviewProvenance,
): string {
  const limits = {
    task_title_chars: MODEL_TOOL_CANDIDATE_LIMITS.maxTaskTitleChars,
    task_goal_chars: MODEL_TOOL_CANDIDATE_LIMITS.maxTaskGoalChars,
    task_current_context_chars: MODEL_TOOL_CANDIDATE_LIMITS.maxTaskCurrentContextChars,
  };
  const meta = Object.entries(governance)
    .map(([name, value]) => `<meta name="${escapeHtml(name.replaceAll("_", "-"))}" content="${escapeHtml(value)}">`)
    .join("\n  ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${meta}
  <meta name="catalog-schema" content="${escapeHtml(catalog.schema)}">
  <meta name="catalog-status" content="${escapeHtml(catalog.status)}">
  <meta name="catalog-sha256" content="${escapeHtml(provenance.catalogSha256)}">
  <meta name="design-sha256" content="${escapeHtml(provenance.designSha256)}">
  <title>Pi Team Bright — Candidate Model Tool Contract</title>
  <style>
    :root { color-scheme: light dark; --bg:#f5f3ed; --panel:#fffdf8; --ink:#1f2a2a; --muted:#66706c; --line:#d8d5ca; --accent:#176b5b; --accent-soft:#dff1eb; --warn:#8c4f12; --warn-soft:#fff0d8; --code:#152422; --code-ink:#e9f7f2; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    a { color:var(--accent); } code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    .shell { display:grid; grid-template-columns:250px minmax(0,1fr); max-width:1500px; margin:auto; }
    nav { position:sticky; top:0; height:100vh; padding:28px 22px; border-right:1px solid var(--line); background:color-mix(in srgb,var(--panel) 90%,transparent); }
    nav strong { display:block; margin-bottom:20px; } nav a { display:block; padding:7px 0; text-decoration:none; color:var(--muted); } nav a:hover { color:var(--accent); }
    main { min-width:0; padding:56px clamp(24px,5vw,80px) 100px; }
    .hero { max-width:1000px; margin-bottom:56px; } .badge { display:inline-block; padding:5px 10px; border-radius:999px; color:var(--warn); background:var(--warn-soft); font-weight:700; letter-spacing:.04em; text-transform:uppercase; font-size:12px; }
    h1 { max-width:900px; font-size:clamp(38px,6vw,72px); line-height:1.02; letter-spacing:-.04em; margin:18px 0; } h2 { font-size:clamp(28px,4vw,42px); line-height:1.1; letter-spacing:-.025em; margin:0; } h3 { font-size:26px; margin:6px 0 20px; } h4 { margin:18px 0 8px; }
    .lede { max-width:800px; font-size:20px; color:var(--muted); } .journey { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:28px; } .journey span { padding:8px 12px; border:1px solid var(--line); border-radius:8px; background:var(--panel); } .journey b { color:var(--accent); }
    .section-heading { margin:70px 0 24px; } .eyebrow { color:var(--accent); font-size:12px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
    .governance dl { display:grid; gap:1px; overflow:hidden; border:1px solid var(--line); border-radius:14px; background:var(--line); } .governance dl div { display:grid; grid-template-columns:160px 1fr; gap:20px; padding:16px 18px; background:var(--panel); } dt { font-weight:800; } dd { margin:0; color:var(--muted); }
    .scenario,.tool-card,.projection { margin:0 0 30px; padding:28px; border:1px solid var(--line); border-radius:18px; background:var(--panel); box-shadow:0 12px 35px rgba(25,45,40,.06); }
    .scenario-grid,.code-grid,.two-col { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:18px; } .scenario-grid > *,.code-grid > *,.two-col > * { min-width:0; } .scenario-grid section,.reasoning,.review { padding:16px; border-radius:12px; background:var(--accent-soft); } .review { margin-top:18px; background:var(--warn-soft); }
    .code-grid { margin:18px 0; } pre { width:100%; overflow:auto; max-height:560px; margin:0; padding:18px; border-radius:12px; background:var(--code); color:var(--code-ink); font-size:13px; line-height:1.5; } pre.model-return { white-space:pre-wrap; overflow-wrap:anywhere; }
    .call-signature { display:inline-block; margin:4px 0 20px; padding:12px 15px; border-radius:9px; background:var(--code); color:var(--code-ink); font-size:17px; }
    table { width:100%; border-collapse:collapse; margin:16px 0 28px; } th,td { padding:12px 10px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; } th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; } .required { color:var(--accent); font-weight:800; }
    .result-grid,.limit-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; } .result-variant,.limit { padding:16px; border:1px solid var(--line); border-radius:12px; } .limit strong { display:block; font-size:24px; color:var(--accent); }
    details { margin-top:16px; padding:14px; border:1px solid var(--line); border-radius:10px; } summary { cursor:pointer; font-weight:750; }
    .provenance { margin-top:70px; padding-top:22px; border-top:1px solid var(--line); color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
    @media (max-width:850px) { .shell{display:block} nav{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)} main{padding-top:36px}.scenario-grid,.code-grid,.two-col{grid-template-columns:1fr}.governance dl div{grid-template-columns:1fr;gap:4px} }
    @media (prefers-color-scheme:dark) { :root{--bg:#101715;--panel:#17211f;--ink:#e9efec;--muted:#abb8b3;--line:#33413d;--accent:#6fd4bb;--accent-soft:#1d3932;--warn:#ffbf75;--warn-soft:#3a2a18;--code:#09110f;--code-ink:#d8f4eb} }
  </style>
</head>
<body>
<div class="shell">
  <nav aria-label="Review navigation">
    <strong>Pi Team Bright<br>Contract review</strong>
    <a href="#scope">Scope</a><a href="#journey">Journey</a>
    ${catalog.scenarios.map((scenario) => `<a href="#scenario-${escapeHtml(scenario.id)}">${escapeHtml(scenario.title)}</a>`).join("")}
    ${catalog.tools.map((tool) => `<a href="#tool-${escapeHtml(tool.name)}">${escapeHtml(tool.name)}</a>`).join("")}
    <a href="#projection">Result projection boundary</a><a href="#limits">Field limits</a><a href="#schemas">Exact schemas</a>
  </nav>
  <main>
    <header class="hero">
      <span class="badge">Candidate · not registered with Pi</span>
      <h1>Create the Team. Build a deep Worker. See what changed.</h1>
      <p class="lede">The long-lived leader chooses Worker scope and Team view. Pi Team Bright resolves the active Team and owns transport state. The default model return is minified, named JSON with the same validated semantics.</p>
      <div class="journey" id="journey"><span>Create Team</span><b>→</b><span>Find deep area</span><b>→</b><span>Ensure Worker</span><b>→</b><span>Assign Tasks</span><b>→</b><span>Snapshot</span><b>→</b><span>Updates</span><b>→</b><span>Act</span></div>
    </header>
    ${governanceHtml(governance)}
    <section id="scenarios"><div class="section-heading"><span class="eyebrow">Decision review</span><h2>Leader scenarios first</h2></div>${catalog.scenarios.map(scenarioHtml).join("")}</section>
    <section id="tools"><div class="section-heading"><span class="eyebrow">Four first-journey calls</span><h2>Candidate tool contracts</h2></div>${catalog.tools.map((tool, index) => toolHtml(tool, index, catalog.tools.length)).join("")}</section>
    <section class="projection" id="projection">
      <span class="eyebrow">Initial delivery boundary</span><h2>Named JSON with unchanged semantics</h2>
      <p>The semantic result is validated, passed through an identity projection, and serialized without formatting. The model sees the named fields directly.</p>
      <p>Projection is an internal implementation detail. Alternative encodings are deferred experiments and are outside the initial end-to-end delivery. They cannot change tool semantics, extension features, or domain behavior.</p>
    </section>
    <section id="limits"><div class="section-heading"><span class="eyebrow">Accepted starting budgets</span><h2>Concise Task fields</h2></div><p>No candidate limit is placed on Team Workers, nonterminal Tasks, or journal entries. Paging is not part of this contract.</p><div class="limit-grid">${Object.entries(limits).map(([name, value]) => `<div class="limit"><strong>${escapeHtml(value)}</strong>${escapeHtml(name.replaceAll("_", " "))}</div>`).join("")}</div></section>
    <section id="schemas"><div class="section-heading"><span class="eyebrow">Executable candidate</span><h2>Exact schemas and examples</h2></div>
      ${catalog.tools.map((tool) => `<h3><code>${escapeHtml(tool.name)}</code></h3><details><summary>Parameter JSON Schema</summary><pre>${json(tool.parameters)}</pre></details><details><summary>Raw result JSON Schema</summary><pre>${json(tool.result)}</pre></details>${tool.examples.map((example) => `<details><summary>${escapeHtml(example.title)}</summary><div class="code-grid"><section><h4>Call</h4><pre>${json(example.call)}</pre></section><section><h4>Default model return</h4><pre class="model-return">${escapeHtml(serializeCandidateToolResult(tool.name as CandidateProjectedTool, example.result))}</pre></section></div><details><summary>Raw semantic JSON</summary><pre>${json(example.result)}</pre></details></details>`).join("")}`).join("")}
    </section>
    <footer class="provenance"><div>Catalog schema: ${escapeHtml(catalog.schema)} · status: ${escapeHtml(catalog.status)}</div><div>Base revision: ${escapeHtml(provenance.baseRevision)}</div><div>Catalog SHA-256: ${escapeHtml(provenance.catalogSha256)}</div><div>Design SHA-256: ${escapeHtml(provenance.designSha256)}</div></footer>
  </main>
</div>
</body>
</html>`;
}
