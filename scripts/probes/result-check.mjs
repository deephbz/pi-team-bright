#!/usr/bin/env node
// Synthetic result boundary only. No Team store, Pi process, or carrier calls.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
require('ts-node').register({ transpileOnly: true, project: path.join(root, 'tsconfig.json') });
const ts = require('typescript');
const base = process.env.RESULT_CHECK_BASE ?? '05379f3';
const output = process.argv[2];
if (!output) throw new Error('Usage: node scripts/probes/result-check.mjs OUTPUT.json');
const baselineOnly = process.env.RESULT_CHECK_BASELINE_ONLY === '1';
const samples = Number(process.env.RESULT_CHECK_SAMPLES ?? 24);
const counts = () => ({ interpreted: 0, compiled: 0, compilations: 0, checkedBytes: 0 });
function load(source, relative, intercept) {
  const filename = path.join(root, relative);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const nativeRequire = createRequire(filename);
  mod.require = specifier => intercept(specifier) ?? nativeRequire(specifier);
  mod._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return mod.exports;
}
function variant(name, source) {
  const state = { counts: counts(), count: true };
  const bytes = value => { if (state.count) state.counts.checkedBytes += Buffer.byteLength(JSON.stringify(value)); };
  const projection = load(source, 'src/model-tool-contract/result-projection.ts', specifier => {
    if (specifier === 'typebox/value') return { ...require(specifier), Check(schema, value) {
      if (state.count) state.counts.interpreted++;
      bytes(value);
      return require(specifier).Check(schema, value);
    } };
    if (specifier === 'typebox/compile') return { ...require(specifier), Compile(schema) {
      if (state.count) state.counts.compilations++;
      const validator = require(specifier).Compile(schema);
      assert.equal(validator.IsAccelerated(), true);
      const check = validator.Check.bind(validator);
      validator.Check = value => { if (state.count) state.counts.compiled++; bytes(value); return check(value); };
      return validator;
    } };
  });
  const executors = load(fs.readFileSync(path.join(root, 'src/model-tool-contract/executors.ts'), 'utf8'), 'src/model-tool-contract/executors.ts', s => s === './result-projection' ? projection : undefined);
  return { name, state, projection, executors };
}
const taskCount = 112, workerCount = 17;
const tasks = Array.from({ length: taskCount }, (_, i) => ({
  id: `task-${i}`, title: `Synthetic task ${i}`, goal: 'Verify the synthetic result boundary. '.repeat(40),
  assignee: `worker-${i % workerCount}`, needs: [], status: 'ready', state: { kind: 'ready' },
  current_context: 'Not started.', version: `v_${i.toString(16).padStart(16, '0')}`, attempts_started: 0,
  relations: [], dependency_state: { kind: 'ready', active_blocker_ids: [] },
}));
const workers = Array.from({ length: workerCount }, (_, i) => ({ name: `worker-${i}`, scope: `Synthetic scope ${i}`, carrier: 'connected', nonterminalTaskIds: tasks.filter(t => t.assignee === `worker-${i}`).map(t => t.id) }));
const snapshot = { kind: 'snapshot', team: { name: 'synthetic', purpose: 'Result validation benchmark', lifecycle: 'active' }, workers, tasks, alerts: [], alertsOmitted: 0 };
const updates = { kind: 'updates', teamChanges: [], workerChanges: workers.map(w => ({ worker: w.name, scope: w.scope, kind: 'created', text: 'Synthetic worker' })), taskChanges: tasks.map(t => ({ taskId: t.id, changeKinds: ['created'], journalEntries: [], current: t })), alerts: [] };
const graph = { kind: 'created', operationId: 'synthetic-graph', graphVersion: 'g_0123456789abcdef', replayed: false, tasksByKey: Object.fromEntries(tasks.map(t => [t.id, t])), readyTaskIds: tasks.map(t => t.id) };
async function invoke(v, operation) {
  let pending;
  const port = { coordination: { readTeamSync: async () => operation === 'snapshot' ? snapshot : updates, setPendingObservationResult: (_session, model) => { pending = model; } }, task: { createTaskGraph: async () => graph } };
  const executor = v.executors.createModelToolJourneyExecutors(port);
  const tool = operation === 'graph' ? 'task_graph_apply' : 'team_sync';
  const result = operation === 'graph'
    ? await executor.taskCreate('synthetic-session', { operation_id: graph.operationId, tasks: tasks.map(t => ({ key: t.id, title: t.title, goal: t.goal, assignee: t.assignee })) })
    : await executor.teamSync('synthetic-session', { view: operation });
  const assembled = v.projection.assembleToolResult(tool, result);
  if (pending) assert.deepEqual(JSON.parse(assembled.content[0].text), pending);
  return assembled;
}
const sourcePath = 'src/model-tool-contract/result-projection.ts';
const baseline = variant('baseline', execFileSync('git', ['show', `${base}:${sourcePath}`], { cwd: root, encoding: 'utf8' }));
const variants = baselineOnly ? [baseline] : [baseline, variant('prototype', fs.readFileSync(path.join(root, sourcePath), 'utf8'))];
const rows = [];
for (const operation of ['snapshot', 'updates', 'graph']) {
  let expected;
  for (const v of variants) {
    v.state.counts = counts();
    v.state.count = true;
    const uptime = execFileSync('uptime', { encoding: 'utf8' }).trim();
    const start = performance.now();
    const result = await invoke(v, operation);
    const ms = performance.now() - start;
    if (expected) assert.deepEqual(result, expected); else expected = result;
    rows.push({ operation, variant: v.name, phase: 'first-use-counted', uptime, ms, ...v.state.counts, semanticBytes: Buffer.byteLength(JSON.stringify(result.details)), modelBytes: Buffer.byteLength(result.content[0].text) });
    v.state.count = false;
    for (let i = 0; i < 3; i++) await invoke(v, operation);
  }
  for (let i = 0; i < samples; i++) {
    // Alternate AB / BA. Counters and payload sizing are disabled during timings.
    for (const v of i % 2 ? [...variants].reverse() : variants) {
      const uptime = execFileSync('uptime', { encoding: 'utf8' }).trim();
      const start = performance.now();
      const result = await invoke(v, operation);
      const ms = performance.now() - start;
      assert.deepEqual(result, expected);
      rows.push({ operation, variant: v.name, phase: 'warm', sample: i, uptime, ms });
    }
  }
}
const metadata = { base, node: process.version, typebox: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/typebox/package.json'), 'utf8')).version, workerCount, taskCount, samples, baselineOnly, scope: 'Actual executors plus assembly; synthetic port results; no backend I/O. Timing includes output equality check against pending sync result.' };
fs.writeFileSync(output, JSON.stringify({ metadata, rows }, null, 2) + '\n');
console.log(JSON.stringify({ output, metadata, counts: rows.filter(r => r.phase === 'first-use-counted') }, null, 2));
