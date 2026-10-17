// Explicitly opt in with node --require. Never auto-loaded by PTB.
const { fork } = require('node:child_process');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

if (process.env.PTB_FREEZE_DIR && !process.env.PTB_FREEZE_OWNER_PID) {
  process.env.PTB_FREEZE_OWNER_PID = String(process.pid); // descendants must not record Workers
  const child = fork(path.join(__dirname, 'diagnostic-watchdog.cjs'), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  const interval = Math.max(20, Number(process.env.PTB_FREEZE_INTERVAL_MS) || 100);
  let pending = 0, dropped = 0, stopped = false;
  let windowStart = performance.now(), inWindow = 0;
  const send = (event, fields = {}) => {
    if (stopped || !child.connected) return;
    const now = performance.now();
    if (now - windowStart >= 1000) { windowStart = now; inWindow = 0; }
    // Bound both IPC backlog and event rate, including pathological input floods.
    if (pending >= 16 || (event !== 'heartbeat' && ++inWindow > 50)) { dropped++; return; }
    pending++;
    try {
      child.send({ event, at: Date.now(), monoMs: now, pid: process.pid, dropped, ...fields }, () => { pending--; });
      dropped = 0;
    } catch { pending--; dropped++; }
  };
  // Extension bridge accepts only explicitly payload-free fields.
  globalThis.__ptbFreezeRecord = (event, fields = {}) => {
    if (!['session_start', 'session_shutdown', 'agent_start', 'agent_end', 'tool_begin', 'tool_end'].includes(event)) return;
    send(event, {
      ...(typeof fields.call === 'string' ? { call: fields.call.slice(0, 16) } : {}),
      ...(typeof fields.tool === 'string' ? { tool: fields.tool.slice(0, 64) } : {}),
      ...(typeof fields.isError === 'boolean' ? { isError: fields.isError } : {}),
    });
  };
  const originalEmit = process.stdin.emit;
  process.stdin.emit = function (event, ...args) {
    if (event === 'data' && !stopped) {
      const chunk = args[0];
      const isBuffer = Buffer.isBuffer(chunk);
      send('stdin_dispatch', {
        bytes: isBuffer ? chunk.length : Buffer.byteLength(String(chunk)),
        hasEscape: isBuffer ? chunk.includes(27) : String(chunk).includes('\x1b'),
      });
    }
    return originalEmit.call(this, event, ...args);
  };
  send('preload_start', { intervalMs: interval });
  const timer = setInterval(() => send('heartbeat'), interval);
  timer.unref();
  child.on('error', () => { stopped = true; clearInterval(timer); });
  child.on('exit', () => { stopped = true; clearInterval(timer); });
  child.unref();
  child.channel?.unref();
  process.once('exit', () => { clearInterval(timer); if (child.connected) child.disconnect(); });
}
