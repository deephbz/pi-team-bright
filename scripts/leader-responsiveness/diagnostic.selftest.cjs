const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const preload = path.join(__dirname, 'diagnostic-preload.cjs');

async function run(source, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ptb-recorder-'));
  const env = { ...process.env, NODE_OPTIONS: '', PTB_FREEZE_DIR: dir,
    PTB_FREEZE_INTERVAL_MS: '25', PTB_FREEZE_STALL_MS: '125', ...overrides };
  delete env.PTB_FREEZE_OWNER_PID;
  const child = spawn(process.execPath, ['--require', preload, '-e', source], { env, stdio: 'ignore' });
  const timeout = setTimeout(() => child.kill(), 5000);
  const code = await new Promise(resolve => child.on('exit', resolve));
  clearTimeout(timeout);
  assert.equal(code, 0, 'diagnostics must not keep a completed Leader alive');
  // IPC disconnect is processed by the independent watchdog after Leader exit.
  let files, text;
  for (let attempt = 0; attempt < 100; attempt++) {
    files = await fs.readdir(dir);
    text = (await Promise.all(files.map(file => fs.readFile(path.join(dir, file), 'utf8')))).join('');
    if (text.includes('leader_disconnected')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const rows = text.trim().split('\n').filter(Boolean).map(JSON.parse);
  return { dir, files, text, rows };
}

test('external watchdog observes a blocked JS loop, recovery, and payload-free input dispatch', async () => {
  const result = await run(`
    setTimeout(() => {
      globalThis.__ptbFreezeRecord('tool_begin', { call: 'abc', tool: 'team_sync' });
      process.stdin.emit('data', Buffer.from('PRIVATE_INPUT\\x1b'));
      const start = Date.now(); while (Date.now() - start < 400) {}
      globalThis.__ptbFreezeRecord('tool_end', { call: 'abc', tool: 'team_sync' });
    }, 200);
    setTimeout(() => {}, 850);
  `);
  try {
    assert(!result.text.includes('PRIVATE_INPUT'));
    const stall = result.rows.find(r => r.event === 'heartbeat_stall');
    const recovery = result.rows.find(r => r.event === 'heartbeat_recovered');
    assert(stall && stall.gapMs >= 125);
    assert(recovery && recovery.gapMs >= 300);
    const begin = result.rows.find(r => r.event === 'tool_begin');
    const end = result.rows.find(r => r.event === 'tool_end');
    assert.equal(begin.call, end.call);
    assert(end.monoMs - begin.monoMs >= 390);
    assert(result.rows.some(r => r.event === 'stdin_dispatch' && r.hasEscape && r.bytes === 14));
    assert(result.rows.some(r => r.event === 'leader_disconnected'));
    console.log(JSON.stringify({ syntheticStallMs: stall.gapMs, recoveryGapMs: recovery.gapMs,
      syntheticToolMs: end.monoMs - begin.monoMs }));
  } finally { await fs.rm(result.dir, { recursive: true, force: true }); }
});

test('flood is rate bounded, drops observable, files rotated, no more than two retained', async () => {
  const result = await run(`
    const flood = setInterval(() => {
      for (let i = 0; i < 1000; i++) process.stdin.emit('data', Buffer.from('secret'));
    }, 60);
    setTimeout(() => clearInterval(flood), 1100);
    setTimeout(() => {}, 1300);
  `, { PTB_FREEZE_MAX_BYTES: '4096' });
  try {
    assert.equal(result.files.length, 2);
    for (const file of result.files) assert((await fs.stat(path.join(result.dir, file))).size <= 4096);
    assert(result.rows.some(r => r.dropped > 0));
    assert(!result.text.includes('secret'));
  } finally { await fs.rm(result.dir, { recursive: true, force: true }); }
});
