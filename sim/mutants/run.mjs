#!/usr/bin/env node
// Run only in an archived scratch copy. Never apply a mutant to the checkout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'];
if (ids.some(id => !/^M[1-6]$/.test(id))) throw new Error('Use M1 through M6');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const revision = git('rev-parse', 'HEAD');
const scratch = fs.mkdtempSync(path.join(root, '.mutant-scratch-'));
const run = (command, args, cwd = scratch, env = process.env) => {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
};
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const targets = { M1: ['P4'], M2: ['retry'], M3: ['E3'], M4: ['P8'], M5: ['E5'], M6: ['P8', 'P9'] };
try {
  const archive = path.join(scratch, 'source.tar');
  execFileSync('git', ['archive', '--format=tar', '-o', archive, revision], { cwd: root });
  run('tar', ['-xf', archive]); fs.rmSync(archive);
  fs.cpSync(path.join(root, 'sim/mutants'), path.join(scratch, 'sim/mutants'), { recursive: true });
  fs.symlinkSync(fs.realpathSync(path.join(root, 'node_modules')), path.join(scratch, 'node_modules'), 'dir');
  for (const id of ids) {
    const started = Date.now();
    const output = path.join(root, 'sim/results/mutants', id);
    fs.mkdirSync(output, { recursive: true });
    const patch = path.join(scratch, 'sim/mutants', `${id}.patch`);
    const files = [...fs.readFileSync(patch, 'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1]);
    const before = files.map(file => digest(path.join(scratch, file)));
    const test = mode => run('npx', ['--no-install', 'vitest', 'run', '--config', 'sim/mutants/gate.config.ts'], scratch,
      { ...process.env, PI_MUTANT: id, PI_MUTANT_MODE: mode, PI_MUTANT_OUTPUT: output });
    const diagnosticName = { M4: 'captures the snapshot watermark before Task hydration', M6: 'commits only native persistence and stamps the page boundary, never the journal head' }[id];
    const diagnostic = phase => {
      if (!diagnosticName) return;
      const report = path.join(scratch, 'diagnostic.json');
      const result = spawnSync('npx', ['--no-install', 'vitest', 'run', 'src/coordination/sync-continuity.test.ts', '-t', diagnosticName, '--reporter=json', '--outputFile', report], { cwd: scratch, encoding: 'utf8' });
      if (![0, 1].includes(result.status) || !fs.existsSync(report)) throw new Error('Diagnostic did not complete');
      const raw = JSON.parse(fs.readFileSync(report, 'utf8'));
      const assertions = raw.testResults.flatMap(s => s.assertionResults).filter(a => a.status !== 'pending').map(a => ({ title: a.title, status: a.status }));
      if (!assertions.length) throw new Error('Diagnostic selected no assertions');
      fs.writeFileSync(path.join(output, `${phase}.diagnostic.json`), JSON.stringify({ scope: 'Existing unit assertion; not the simulator gate oracle', exitCode: result.status, assertions }, null, 2) + '\n');
    };
    test('control'); diagnostic('control');
    let applied = false;
    try {
      run('git', ['apply', '--check', patch]); run('git', ['apply', patch]); applied = true;
      run('npx', ['--no-install', 'tsc', '--noEmit']);
      test('campaign'); diagnostic('mutant');
    } finally {
      if (applied) run('git', ['apply', '-R', patch]);
      files.forEach((file, i) => { if (digest(path.join(scratch, file)) !== before[i]) throw new Error(`Revert failed: ${file}`); });
    }
    test('control-minimal');
    const read = name => JSON.parse(fs.readFileSync(path.join(output, name), 'utf8'));
    const control = read('minimal.control.json'); const mutant = read('minimal.mutant.json');
    const killedBy = targets[id].filter(property => !control.stopped && !mutant.stopped && control.results[property]?.status === 'pass' && mutant.results[property]?.status === 'violation');
    const result = { id, status: killedBy.length ? 'killed' : 'survived', targets: targets[id], killedBy,
      sourceRevision: revision, patchSha256: digest(patch), traceId: mutant.traceId, replayVerified: mutant.replayVerified,
      control: control.results, mutant: mutant.results, scratchReverted: true, runtimeMs: Date.now() - started };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    fs.rmSync(path.join(output, 'witness.trace.json'), { force: true });
    console.info(`${id}: ${result.status}; ${result.traceId}; ${killedBy.join(',')}`);
  }
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
