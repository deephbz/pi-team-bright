// Separate process: remains responsive when the Leader JS thread is blocked.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const dir = process.env.PTB_FREEZE_DIR;
const owner = process.env.PTB_FREEZE_OWNER_PID;
const threshold = Math.max(50, Number(process.env.PTB_FREEZE_STALL_MS) || 500);
const maxBytes = Math.max(4096, Number(process.env.PTB_FREEZE_MAX_BYTES) || 4 * 1024 * 1024);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, `leader-${owner}.jsonl`);
let fd = fs.openSync(file, 'a', 0o600), size = fs.fstatSync(fd).size;
let lastHeartbeat = performance.now(), stalled = false;
function record(data) {
  const line = JSON.stringify({ ...data, observedAt: Date.now() }) + '\n';
  const bytes = Buffer.byteLength(line);
  if (size + bytes > maxBytes) {
    fs.closeSync(fd);
    fs.renameSync(file, file + '.1');
    fd = fs.openSync(file, 'w', 0o600); size = 0;
  }
  fs.writeSync(fd, line); size += bytes;
}
record({ event: 'watchdog_start', pid: Number(owner), thresholdMs: threshold });
process.on('message', message => {
  if (message.event === 'heartbeat') {
    const gap = performance.now() - lastHeartbeat;
    if (stalled) record({ event: 'heartbeat_recovered', gapMs: gap });
    lastHeartbeat = performance.now(); stalled = false;
  }
  record(message);
});
const timer = setInterval(() => {
  const gap = performance.now() - lastHeartbeat;
  if (!stalled && gap > threshold) {
    stalled = true;
    record({ event: 'heartbeat_stall', gapMs: gap });
  }
}, Math.max(20, Math.min(100, threshold / 4)));
process.on('disconnect', () => {
  clearInterval(timer);
  record({ event: 'leader_disconnected' });
  fs.closeSync(fd);
  process.exit(0);
});
