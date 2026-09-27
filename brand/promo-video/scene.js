// Pi Team Bright promo v6. Nu-Brutalism × VectorHeart forms, Mirror's Edge colour.
// Every frame is a pure function of t. Motion system: see timeline.js ("follow the handoff").
const W = 1920, H = 1080;
const cv = document.getElementById('out');
const ctx = cv.getContext('2d');
// Palette, type, primitives, and the mark come from the brand source (brand/brand.js).
const BR = PTBBrand, BC = BR.color;
const P = {
  ground: BC.ground, concrete: BC.concrete, white: BC.white, ink: BC.ink, grey: BC.grey,
  red: BC.focus, cyan: BC.agents[0], orange: BC.agents[1], yellow: BC.agents[2], blue: BC.agents[3], green: BC.ok,
};
const WC = { lead: P.red, scout: P.cyan, builder: P.orange, ui: P.yellow, reviewer: P.blue };
const ON = BR.on;
const DISPLAY = 'display', TECH = 'tech', MONO = 'mono';
const F = 1 / 30;

// ---------- math ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => a + (b - a) * k;
const seg = (t, a, b) => clamp((t - a) / (b - a));
const ease = k => k * k * (3 - 2 * k);
const easeOut = k => 1 - Math.pow(1 - k, 3);
const easeIn = k => k * k * k;
const easeInOut = k => (k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const quint = k => (k < .5 ? 16 * k ** 5 : 1 - Math.pow(-2 * k + 2, 5) / 2);
const mj = u => u * u * u * (10 - 15 * u + 6 * u * u); // minimum-jerk
const backOut = k => { const c = 1.6; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };
const hash = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const strHash = s => [...s].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 9973;
const sceneAt = name => TL.scenes.find(s => s[0] === name);
const B = TL.beats;

// ---------- primitives ----------
const shape = (x, y, w, h, ch = 0) => BR.shape(ctx, x, y, w, h, ch);
function hatch(x, y, w, h, o = {}) {
  const gap = o.gap ?? 22, lw = o.lw ?? 8, off = ((o.off ?? 0) % gap + gap) % gap;
  ctx.save(); shape(x, y, w, h, o.ch ?? 0); ctx.clip();
  ctx.strokeStyle = o.color ?? P.ink; ctx.lineWidth = lw; ctx.globalAlpha *= o.alpha ?? 1;
  ctx.beginPath(); for (let d = -h - gap + off; d < w + gap; d += gap) { ctx.moveTo(x + d, y + h); ctx.lineTo(x + d + h, y); } ctx.stroke();
  ctx.restore();
}
function box(x, y, w, h, o = {}) {
  if (!o.hatch) return BR.box(ctx, x, y, w, h, o);
  BR.box(ctx, x, y, w, h, { ...o, lw: 0 }); hatch(x, y, w, h, { ch: o.ch ?? 0, ...o.hatch }); BR.box(ctx, x, y, w, h, { ...o, fill: 'none', shadow: 0 });
}
const txt = (s, x, y, o = {}) => BR.txt(ctx, s, x, y, o);
const measure = (s, size, font = DISPLAY, weight = 400, ls = 0) => BR.measure(ctx, s, size, font, weight, ls);
function sticker(s, x, y, o = {}) {
  const k = o.k ?? 1; if (k <= 0) return 0;
  return BR.sticker(ctx, s, x, y, { ...o, scale: o.noPop ? 1 : backOut(k), alpha: clamp(k * 3) });
}
function stamp(s, x, y, color, k, rot = -.2, size = 44) {
  if (k <= 0) return;
  const sc = lerp(1.8, 1, easeOut(clamp(k * 1.6))), w = measure(s, size, DISPLAY, 400, 3) + 44, h = size + 30;
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(sc, sc); ctx.globalAlpha *= clamp(k * 3);
  ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.lineWidth = 2; ctx.strokeRect(-w / 2 + 8, -h / 2 + 8, w - 16, h - 16);
  txt(s, 0, 3, { size, align: 'center', color, ls: 3 });
  ctx.restore();
}
function barcode(x, y, w, h, seed) {
  ctx.save(); ctx.fillStyle = P.ink;
  for (let p = 0, i = 0; p < h; i++) { const bw = 2 + Math.floor(hash(seed + i) * 5); ctx.fillRect(x, y + p, w, Math.min(bw, h - p)); p += bw + 2 + Math.floor(hash(seed + i + 50) * 4); }
  ctx.restore();
}
function arrowHead(x, y, ang, size = 18, color = P.ink) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-size, -size * .6); ctx.lineTo(-size, size * .6); ctx.closePath(); ctx.fill(); ctx.restore();
}
function background() { ctx.fillStyle = P.ground; ctx.fillRect(-4000, -4000, 12000, 12000); }
function groundHatch(t) {
  ctx.save(); ctx.globalAlpha = .035; ctx.strokeStyle = P.ink; ctx.lineWidth = 2;
  const off = (t * 20) % 26; ctx.beginPath();
  for (let d = -H + off; d < W; d += 26) { ctx.moveTo(d, H); ctx.lineTo(d + H, 0); }
  ctx.stroke(); ctx.restore();
}

// ---------- contact physics ----------
// Receipt: 2-frame compression, then a settle with small overshoot.
// Decision: 3-frame anticipation swell, 3-frame hitstop, recoil; the frame also shakes.
function contact(t, tc, level = 'receipt') {
  if (tc == null) return { s: 1, sh: 1, flash: 0 };
  const dt = t - tc;
  if (dt < 0) return { s: level === 'decision' ? 1 + .04 * seg(t, tc - 3 * F, tc) : 1, sh: 1, flash: 0 };
  const hold = level === 'decision' ? 3 * F : 2 * F;
  if (dt < hold) return { s: level === 'decision' ? .9 : .95, sh: .3, flash: dt < F ? 1 : 0 };
  const d = dt - hold;
  return { s: 1 - (level === 'decision' ? .08 : .04) * Math.exp(-d * 12) * Math.cos(d * 20), sh: 1 - .7 * Math.exp(-d * 14), flash: 0 };
}
const lastBefore = (t, list) => { let best = null; for (const x of list) if (x <= t && (best == null || x > best)) best = x; return best; };
function shake(t) {
  let dx = 0, dy = 0;
  for (const tc of TL.decisions) {
    const dt = t - tc; if (dt < 0 || dt > .4) continue;
    const a = 5 * Math.exp(-dt * 16), f = Math.floor(t * 30);
    dx += (hash(f + tc * 7) - .5) * 2 * a * .4; dy += a * (.6 + (hash(f + 3) - .5) * .8);
  }
  return [dx, dy];
}

// ---------- captions (screen space, top) ----------
function captions(t) {
  for (const [s, a, b] of TL.captions) {
    const k = Math.min(ease(seg(t, a, a + .3)), 1 - ease(seg(t, b - .25, b)));
    if (k <= 0) continue;
    const size = 44, w = measure(s, size, DISPLAY, 400, 1) + 72, h = 84, y = 92 - (1 - easeOut(k)) * 40;
    ctx.save(); ctx.globalAlpha *= clamp(k * 2);
    box(W / 2 - w / 2, y - h / 2, w, h, { fill: P.ink, shadow: 9, shadowColor: P.red, lw: 0 });
    txt(s, W / 2, y + 3, { size, align: 'center', color: P.white, ls: 1 });
    ctx.restore();
  }
}

// ---------- code with syntax colour and typing ----------
function tokens(line) {
  const out = [], re = /("[^"]*"?)|([A-Za-z_]+)(?=\()|([A-Za-z_]+)(?=:)|([{}()\[\],:])|(\s+)|([^"\s{}()\[\],:]+)/g;
  let m; while ((m = re.exec(line))) out.push([m[0], m[1] ? P.orange : m[2] ? P.blue : m[3] ? P.red : m[4] ? P.grey : null]);
  return out;
}
function codeLines(lines, x, y, t, at, o = {}) {
  const size = o.size ?? 20, lh = size * 1.5, cps = o.cps ?? 80;
  ctx.save(); ctx.font = `500 ${size}px ${BR.font.mono.stack}`; const cw = ctx.measureText('M').width; ctx.restore();
  let n = Math.floor((t - at) * cps), yy = y;
  for (const line of lines) {
    if (n <= 0) break;
    let cx = x;
    for (const [s, color] of tokens(line)) {
      const shown = s.slice(0, Math.max(0, n)); n -= s.length;
      if (shown) txt(shown, cx, yy, { size, font: MONO, weight: 500, color: color ?? P.ink });
      cx += shown.length * cw; if (n < 0) break;
    }
    n -= 1; yy += lh;
  }
}
const typedDone = (lines, at, cps = 80) => at + (lines.join(' ').length + lines.length) / cps;

// ---------- Task state from the shared schedule ----------
const STATE_LABEL = { wait: 'waiting', run: 'in_progress', ok: 'goal_achieved', failed: 'goal_failed', blocked: 'blocked' };
function taskState(key, t) {
  let cur = { s: 'wait', since: -1, note: null }, attempt = 0;
  for (const [at, s, note] of TL.tasks[key].schedule) { if (at > t) break; if (s === 'run' && note !== 'resumed') attempt++; cur = { s, since: at, note }; }
  return { ...cur, attempt };
}
function workerNow(name, t) {
  let best = null;
  for (const [key, task] of Object.entries(TL.tasks)) {
    if (task.worker !== name) continue;
    const st = taskState(key, t);
    if (st.s === 'run' || st.s === 'blocked') return { key, ...st };
    if (st.s !== 'wait' && (!best || st.since > best.since)) best = { key, ...st };
  }
  return best;
}
const LOGS = {
  scout: ['rg "settings" -l', 'map 12 files', 'read docs/api.md', 'draft notes'],
  builder: ['edit settings.ts', 'npm test ✓ 14', 'add null guard', 'tsc --noEmit ✓'],
  ui: ['edit Settings.tsx', 'empty state', 'snapshots ✓', 'a11y check ✓'],
  reviewer: ['read diff · fresh', 'trace null paths', '✗ guard L42', 'coverage ✓'],
};

// ---------- world geometry ----------
const LEAD_FULL = [90, 220, 1740, 780], LEAD = [90, 220, 686, 780];
const TAB = [70, 200, 1780, 820];
const teamRect = i => [796 + (i % 2) * 532, 220 + Math.floor(i / 2) * 400, 512, 380];
const worldRect = i => [2170 + (i % 2) * 326, 220 + Math.floor(i / 2) * 401, 300, 375];
const DX = 900, DY = 130;
const POS = { map: [180, 560], api: [470, 390], ui: [470, 730], review: [760, 560], notes: [1050, 560] };
const TW = 250, TH = 160;
const tpos = key => [POS[key][0] + DX, POS[key][1] + DY];
const TRAY = [872, 560];
const lerpRect = (a, b, k) => a.map((v, i) => lerp(v, b[i], k));
const workerRect = (i, t) => lerpRect(teamRect(i), worldRect(i), easeInOut(seg(t, ...B.relayout)));
const workerIndex = name => TL.workers.findIndex(w => w.name === name);
const paneCenter = (name, t) => { const [x, y, w, h] = workerRect(workerIndex(name), t); return [x + w / 2, y + h * .45]; };
const leadRect = t => lerpRect(LEAD_FULL, LEAD, easeInOut(seg(t, ...B.shrink)));

// ---------- camera ----------
const SHOTS = { id: { cx: 960, cy: 540, z: 1 }, overview: { cx: 1440, cy: 600, z: .686 }, dag: { cx: 1860, cy: 540, z: 1 }, lead: { cx: 1280, cy: 600, z: .768 } };
function camAt(t) {
  const keys = TL.camera;
  if (t <= keys[0][0]) return SHOTS[keys[0][1]];
  for (let i = 1; i < keys.length; i++) {
    const [t1, s1] = keys[i], [t0, s0] = keys[i - 1];
    if (t <= t1) { const k = quint(seg(t, t0, t1)), a = SHOTS[s0], b = SHOTS[s1]; return { cx: lerp(a.cx, b.cx, k), cy: lerp(a.cy, b.cy, k), z: Math.exp(lerp(Math.log(a.z), Math.log(b.z), k)) }; }
  }
  return SHOTS[keys.at(-1)[1]];
}
function applyCam(c) { ctx.translate(W / 2, H / 2); ctx.scale(c.z, c.z); ctx.translate(-c.cx, -c.cy); }

// ---------- carriers ----------
// A carrier travels a shallow arc with minimum-jerk timing and a short trail.
function arcPoint(a, b, u, bow = .18) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1;
  let nx = dy / d, ny = -dx / d; if (ny > 0) { nx = -nx; ny = -ny; }
  const c = [mx + nx * d * bow, my + ny * d * bow], v = 1 - u;
  return [v * v * a[0] + 2 * v * u * c[0] + u * u * b[0], v * v * a[1] + 2 * v * u * c[1] + u * u * b[1]];
}
function carrierShape(kind, color, label) {
  switch (kind) {
    case 'deliver': // folded ticket
      box(-30, -20, 60, 40, { fill: P.white, shadow: 4, lw: 3, ch: 10 }); ctx.fillStyle = color; ctx.fillRect(-28, -18, 46, 12); break;
    case 'slip': { // evidence slip
      const edge = label === 'failed' ? P.red : label === 'blocked' ? P.yellow : P.green;
      box(-22, -28, 44, 56, { fill: P.white, shadow: 4, lw: 3 });
      ctx.fillStyle = edge; ctx.fillRect(-19, -25, 38, 8);
      ctx.fillStyle = P.ink; for (let i = 0; i < 3; i++) ctx.fillRect(-14, -8 + i * 10, 28 - i * 6, 3);
      break; }
    case 'dep':
      ctx.fillStyle = P.ink; ctx.fillRect(-9, -9, 26, 26); ctx.fillStyle = color; ctx.fillRect(-13, -13, 26, 26); ctx.strokeStyle = P.ink; ctx.lineWidth = 3; ctx.strokeRect(-13, -13, 26, 26); break;
    case 'change':
      box(-16, -12, 32, 24, { fill: P.ink, shadow: 0, lw: 0 }); ctx.fillStyle = color; ctx.fillRect(-10, -6, 12, 12); break;
    case 'envelope':
      box(-34, -22, 68, 44, { fill: color, shadow: 5, lw: 3 }); ctx.strokeStyle = ON(color); ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-31, -19); ctx.lineTo(0, 4); ctx.lineTo(31, -19); ctx.stroke();
      if (label) txt(label, 0, 11, { size: 18, align: 'center', color: ON(color) }); break;
    case 'badge':
      sticker(label, 0, 0, { size: 20, bg: P.red, shadow: 4, lw: 3, noPop: true }); break;
    case 'tab': {
      const w = measure(label, 18) + 28; box(-w / 2, -18, w, 36, { fill: color, shadow: 4, lw: 3, ch: 8 }); txt(label, 0, 2, { size: 18, align: 'center', color: ON(color) }); break; }
    case 'mini':
      box(-34, -22, 68, 44, { fill: P.white, shadow: 4, lw: 3, ch: 10 }); ctx.fillStyle = color; ctx.fillRect(-32, -20, 54, 12); break;
  }
}
function carrier(t, t0, t1, from, to, kind, color, label, bow) {
  if (t < t0 || t >= t1) return;
  const u = (t - t0) / (t1 - t0);
  for (let g = 3; g >= 1; g--) {
    const ug = u - g * .05; if (ug <= 0) continue;
    const p = arcPoint(from, to, mj(ug), bow);
    ctx.save(); ctx.globalAlpha *= .12 * (4 - g); ctx.translate(...p); ctx.scale(.9, .9); carrierShape(kind, color, label); ctx.restore();
  }
  const p = arcPoint(from, to, mj(u), bow), tilt = (mj(Math.min(1, u + .02)) - mj(u)) * 8;
  ctx.save(); ctx.translate(...p); ctx.rotate(clamp(tilt, -.2, .2)); carrierShape(kind, color, label); ctx.restore();
}
// Source highlight: 4 frames before a carrier departs.
function sourceGlow(t, t0, x, y, w, h) {
  const k = seg(t, t0 - 4 * F, t0) * (1 - seg(t, t0, t0 + 6 * F));
  if (k > 0) { ctx.save(); ctx.globalAlpha = .35 * k; ctx.fillStyle = P.red; ctx.fillRect(x, y, w, h); ctx.restore(); }
}
// Carriers derived from the Task schedule.
const SCHED_CARRIERS = (() => {
  const out = [];
  for (const [key, task] of Object.entries(TL.tasks)) for (const [tc, s, note, dur] of task.schedule) {
    const d = dur ?? .45; if (d <= 0) continue;
    if (s === 'run' && note !== 'resumed') out.push({ kind: 'deliver', t0: tc - d, t1: tc, key, worker: task.worker, dir: 'toPane' });
    else if (s === 'run' || s === 'ok' || s === 'failed' || s === 'blocked') out.push({ kind: 'slip', t0: tc - d, t1: tc, key, worker: task.worker, dir: 'toTicket', label: s === 'run' ? 'ok' : s });
  }
  return out;
})();
// While a handoff is in flight, background motion pauses (focus budget).
const BUSY = (() => {
  const iv = [...SCHED_CARRIERS.map(c => [c.t0, c.t1]), ...TL.tokens.map(x => [x[2], x[3]]), [B.alert[0], B.alert[1]], [B.batch[1], B.batch[2]]].sort((a, b) => a[0] - b[0]);
  const m = []; for (const [a, b] of iv) { if (m.length && a <= m.at(-1)[1]) m.at(-1)[1] = Math.max(m.at(-1)[1], b); else m.push([a, b]); }
  return m;
})();
const calmT = t => t - BUSY.reduce((s, [a, b]) => s + clamp(t - a, 0, b - a), 0);

// ---------- panes ----------
function pane(x, y, w, h, title, color, o = {}) {
  const head = o.head ?? 52;
  box(x, y, w, h, { fill: P.white, shadow: o.shadow ?? 10, lw: 5 });
  ctx.fillStyle = color; ctx.fillRect(x, y, w, head);
  ctx.strokeStyle = P.ink; ctx.lineWidth = 5; ctx.strokeRect(x, y, w, h);
  ctx.beginPath(); ctx.moveTo(x, y + head); ctx.lineTo(x + w, y + head); ctx.stroke();
  if (title) txt(title.toUpperCase(), x + 20, y + head / 2 + 2, { size: o.titleSize ?? 26, color: ON(color) });
}
function workerBody(x, y, w, h, name, t, size) {
  const now = workerNow(name, t);
  const line = now ? `${now.key} · ${STATE_LABEL[now.s]}` : 'idle · ready for a Task';
  if (now && now.s === 'blocked') { ctx.fillStyle = P.concrete; ctx.fillRect(x + 12, y + 10, w - 24, size * 1.9); hatch(x + 12, y + 10, w - 24, size * 1.9, { alpha: .18, gap: 16, lw: 6 }); }
  const mark = !now ? '· ' : now.s === 'run' ? '▶ ' : now.s === 'ok' ? '✓ ' : '■ ';
  txt(mark + line, x + 20, y + 10 + size, { size, font: MONO, weight: 700, color: !now ? P.grey : now.s === 'ok' ? '#3E9A2C' : P.ink });
  if (!now || now.s !== 'run') return;
  ctx.save(); ctx.beginPath(); ctx.rect(x, y + size * 2.6, w, h - size * 2.6); ctx.clip();
  const pos = calmT(t) * 1.6, b = Math.floor(pos), logs = LOGS[name];
  for (let j = 0; j < 5; j++) {
    const yy = y + size * 3.8 + (j - (pos - b)) * size * 1.7;
    if (yy > y + h - size) break;
    txt(logs[(b + j) % logs.length], x + 20, yy, { size: size * .95, font: MONO, weight: 500, alpha: .8 });
  }
  ctx.restore();
}
const PANE_CONTACTS = Object.fromEntries(TL.workers.map((wk, i) => {
  const list = [B.workerLand[i]];
  for (const c of SCHED_CARRIERS) if (c.worker === wk.name && c.dir === 'toPane') list.push(c.t1);
  if (wk.name === 'ui') list.push(B.alert[1]);
  return [wk.name, list];
}));
function workerPane(i, t, o = {}) {
  const wk = TL.workers[i], land = B.workerLand[i];
  if (t < land) return;
  const [x, y, w, h] = workerRect(i, t), rel = seg(t, ...B.relayout);
  const c = contact(t, lastBefore(t, PANE_CONTACTS[wk.name]));
  const grow = easeOut(seg(t, land, land + .4)); // unfolds downward from its header tab
  const hh = lerp(40, h, grow);
  ctx.save(); ctx.globalAlpha *= o.alpha ?? 1;
  ctx.translate(x + w / 2, y + hh / 2); ctx.scale(c.s, c.s); ctx.translate(-w / 2, -hh / 2);
  const small = rel > .5, head = small ? 44 : 52;
  pane(0, 0, w, hh, wk.name + '-agent', WC[wk.name], { shadow: 8 * c.sh, head, titleSize: small ? 20 : 26 });
  if (grow > .9) {
    ctx.save(); ctx.globalAlpha *= seg(grow, .9, 1);
    if (!small) {
      ctx.globalAlpha *= 1 - rel * 2;
      const label = wk.label.toUpperCase();
      sticker(label, w - 20 - measure(label, 20) / 2 - 12, 26, { size: 20, bg: P.white, k: seg(t, land + .35, land + .6), shadow: 4, lw: 3, rot: .03 });
      txt('idle · ready for a Task', 24, 100, { size: 20, font: MONO, weight: 700, color: P.grey });
      sticker(`role: ${wk.role}`, w / 2, hh / 2 + 40, { size: 28, font: MONO, weight: 700, bg: P.ink, fg: WC[wk.name] === P.blue ? '#7FA6F0' : WC[wk.name], k: seg(t, land + .45, land + .7), shadow: 6, shadowColor: WC[wk.name], lw: 0 });
    } else workerBody(0, head, w, hh - head, wk.name, t, 17);
    ctx.restore();
  }
  if (c.flash) { ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fillRect(0, 0, w, hh); }
  ctx.restore();
}

// ---------- tickets and the DAG ----------
const TICKET_FILL = { wait: P.white, run: P.white, ok: P.green, failed: P.ink, blocked: P.concrete };
const CHIP_COLOR = { wait: P.white, run: P.white, ok: P.green, failed: P.red, blocked: P.yellow };
const UNFOLD_AT = key => B.unfoldTickets + Object.keys(POS).indexOf(key) * .1 + .45;
const TICKET_CONTACTS = Object.fromEntries(Object.keys(POS).map(key => {
  const list = [UNFOLD_AT(key)];
  for (const [tc] of TL.tasks[key].schedule) list.push(tc);
  for (const [, to, , t1] of TL.tokens) if (to === key) list.push(t1);
  return [key, list];
}));
const isDecision = tc => TL.decisions.some(d => Math.abs(d - tc) < 1e-6);
function ticket(key, x, y, t, o = {}) {
  const appear = UNFOLD_AT(key);
  if (t < appear && !o.force) return;
  const task = TL.tasks[key], st = taskState(key, t), wc = WC[task.worker];
  const tc = lastBefore(t, TICKET_CONTACTS[key]), c = contact(t, tc, tc != null && isDecision(tc) ? 'decision' : 'receipt');
  const un = o.force ? 1 : easeOut(seg(t, appear, appear + 8 * F));
  ctx.save(); ctx.translate(x, y); const s = c.s * lerp(.3, 1, un); ctx.scale(s, s);
  const x0 = -TW / 2, y0 = -TH / 2, stub = 50, calm = calmT(t);
  box(x0, y0, TW, TH, {
    fill: TICKET_FILL[st.s], shadow: 10 * c.sh, ch: 26,
    hatch: st.s === 'run' ? { color: wc, alpha: .35, gap: 20, lw: 7, off: calm * 40 } : st.s === 'blocked' ? { alpha: .14, gap: 18, lw: 7 } : null,
  });
  ctx.save(); shape(x0, y0, TW, TH, 26); ctx.clip(); ctx.fillStyle = wc; ctx.fillRect(x0, y0, TW, 46); ctx.restore();
  ctx.strokeStyle = P.ink; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(x0, y0 + 46); ctx.lineTo(x0 + TW, y0 + 46); ctx.stroke();
  shape(x0, y0, TW, TH, 26); ctx.stroke();
  txt(key.toUpperCase(), x0 + 16, y0 + 25, { size: 28, color: ON(wc) });
  const inkOn = st.s === 'failed' ? P.white : P.ink;
  ctx.save(); ctx.strokeStyle = inkOn; ctx.setLineDash([7, 7]); ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x0 + TW - stub, y0 + 52); ctx.lineTo(x0 + TW - stub, y0 + TH - 6); ctx.stroke(); ctx.restore();
  if (st.s !== 'failed') barcode(x0 + TW - stub + 12, y0 + 60, 26, TH - 76, strHash(key));
  txt('@' + task.worker, x0 + 16, y0 + 72, { size: 21, font: TECH, weight: 700, color: inkOn });
  const label = STATE_LABEL[st.s], cw = measure(label, 17, MONO, 700) + 20;
  ctx.fillStyle = st.s === 'failed' ? P.red : P.ink; ctx.fillRect(x0 + 14, y0 + TH - 48, cw, 32);
  txt(label, x0 + 24, y0 + TH - 31, { size: 17, font: MONO, weight: 700, color: st.s === 'failed' ? P.white : CHIP_COLOR[st.s] });
  if (st.attempt >= 2) sticker('#' + st.attempt, x0 + TW - 26, y0 - 6, { size: 20, bg: P.white, rot: .15, shadow: 4, lw: 3, noPop: true });
  if (c.flash) { ctx.fillStyle = 'rgba(255,255,255,.75)'; shape(x0, y0, TW, TH, 26); ctx.fill(); }
  ctx.restore();
  if (st.s === 'ok' && !o.noStamp) {
    ctx.save(); ctx.globalAlpha *= lerp(1, .3, ease(seg(t, st.since + .9, st.since + 1.3)));
    stamp('PROVEN', x + 52, y - 4, P.ink, seg(t, st.since, st.since + .25), -.22, 26);
    ctx.restore();
  }
  if (st.note && st.s !== 'wait' && !o.noNote) txt(st.note, x, y + TH / 2 + 34, { size: 20, font: MONO, weight: 700, align: 'center', alpha: ease(seg(t, st.since, st.since + .3)), color: st.s === 'failed' ? P.red : P.ink });
}
function elbowPts(a, b) {
  const [x1, y1] = [tpos(a)[0] + TW / 2, tpos(a)[1]], [x2, y2] = [tpos(b)[0] - TW / 2 - 6, tpos(b)[1]], mx = (x1 + x2) / 2;
  return [[x1, y1], [mx, y1], [mx, y2], [x2, y2]];
}
function failPts() {
  const [ax, ay] = tpos('api'), [rx, ry] = tpos('review'), pts = [];
  const p0 = [rx, ry - TH / 2], p1 = [rx, ay - TH / 2 - 150], p2 = [ax + 40, ay - TH / 2 - 150], p3 = [ax + 40, ay - TH / 2 - 8];
  for (let i = 0; i <= 30; i++) { const k = i / 30, u = 1 - k; pts.push([0, 1].map(j => u * u * u * p0[j] + 3 * u * u * k * p1[j] + 3 * u * k * k * p2[j] + k * k * k * p3[j])); }
  return pts;
}
function polyLens(pts) { const lens = []; let total = 0; for (let i = 1; i < pts.length; i++) { lens.push(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); total += lens.at(-1); } return { lens, total }; }
function polyAt(pts, k) {
  const { lens, total } = polyLens(pts); let d = k * total;
  for (let i = 1; i < pts.length; i++) { if (d <= lens[i - 1]) { const f = d / lens[i - 1]; return [lerp(pts[i - 1][0], pts[i][0], f), lerp(pts[i - 1][1], pts[i][1], f)]; } d -= lens[i - 1]; }
  return pts.at(-1);
}
function strokePts(pts, k, o = {}) {
  if (k <= 0) return;
  const { lens, total } = polyLens(pts);
  ctx.save(); ctx.strokeStyle = o.color ?? P.ink; ctx.lineWidth = o.lw ?? 5; ctx.lineJoin = 'miter';
  if (o.dash) ctx.setLineDash(o.dash);
  ctx.beginPath(); ctx.moveTo(...pts[0]);
  let d = k * total;
  for (let i = 1; i < pts.length; i++) { if (d <= lens[i - 1]) break; ctx.lineTo(...pts[i]); d -= lens[i - 1]; }
  ctx.lineTo(...polyAt(pts, k)); ctx.stroke(); ctx.restore();
  if (k > .98) { const a = pts.at(-2), b = pts.at(-1); arrowHead(b[0], b[1], Math.atan2(b[1] - a[1], b[0] - a[0]), 18, o.color ?? P.ink); }
}
function dagEdges(t, alpha = 1) {
  const ek = ease(seg(t, ...B.edges));
  if (ek <= 0 || alpha <= 0) return;
  ctx.save(); ctx.globalAlpha *= alpha;
  for (const [key, task] of Object.entries(TL.tasks)) for (const need of task.needs) strokePts(elbowPts(need, key), ek);
  strokePts(failPts(), ek, { dash: [16, 10] });
  const [ax, ay] = tpos('api'), [rx] = tpos('review'), lx = (ax + rx) / 2 + 20;
  sticker('on_goal_failed → api · max 2', lx, ay - TH / 2 - 150, { size: 19, font: MONO, weight: 700, bg: P.white, k: ek, shadow: 4, lw: 3, noPop: true });
  const trav = TL.tokens.find(x => x[4] === 'fail');
  if (t >= trav[3]) sticker('traversal 1/2', lx, ay - TH / 2 - 100, { size: 18, font: MONO, weight: 700, bg: P.ink, shadow: 4, lw: 3, rot: -.04, shadowColor: P.red, k: seg(t, trav[3], trav[3] + .25) });
  ctx.restore();
}
function dagTokens(t) {
  for (const [a, b, t0, t1, kind] of TL.tokens) {
    if (t < t0 || t >= t1) continue;
    const pts = kind === 'fail' ? failPts() : elbowPts(a, b), p = polyAt(pts, mj((t - t0) / (t1 - t0)));
    ctx.save(); ctx.translate(...p); carrierShape('dep', P.red); ctx.restore();
  }
}

// ---------- the lead pane ----------
const LOG = [
  { at: B.teamCreate, lines: ['team_create({ name: "release" })'], cps: 90 },
  ...TL.workers.map((wk, i) => ({ at: B.ensure[i], lines: [`ensure_worker({ name: "${wk.name}", role: "${wk.role}" })`], cps: 110 })),
  { at: B.graphApply, lines: ['task_graph_apply({ tasks: [', '  map, api, ui, review, notes ] })'], cps: 80 },
  { at: B.syncCall, lines: ['team_sync({ view: "updates" })'], cps: 90 },
  { at: B.returned, out: '← returned · 3 changes · 1 batch' },
  { at: B.blockedNote, out: 'ui blocked: needs empty-state copy' },
  { at: B.alertType, lines: ['alert_send({ to: "ui",', '  kind: "clarification",', '  text: "Use: Nothing here yet." })'], cps: 75 },
  { at: B.syncAgain, lines: ['team_sync({ view: "updates" })'], cps: 90 },
];
const LOG_Y = (() => { let yy = 150; return LOG.map(e => { const y = yy; yy += (e.lines ? e.lines.length : 1) * 30 + 12; return y; }); })();
const logIndex = at => LOG.findIndex(e => e.at === at);
// Launch point of a transcript entry (end of its last line), in world space.
function logAnchor(index, t) {
  const [x, y] = leadRect(t), e = LOG[index];
  return [x + 30 + Math.min(620, e.lines.at(-1).length * 12 + 16), y + LOG_Y[index] + (e.lines.length - 1) * 30];
}
function leadPane(t) {
  const [x, y, w, h] = leadRect(t);
  const hit = B.badge[1], isLead = t >= hit, last = lastBefore(t, [hit, B.batch[2]]);
  const c = contact(t, last, last === hit ? 'decision' : 'receipt');
  ctx.save(); ctx.translate(x + w / 2, y + h / 2); ctx.scale(c.s, c.s); ctx.translate(-w / 2, -h / 2);
  pane(0, 0, w, h, null, P.ink, { shadow: 8 * c.sh });
  // The header turns red outward from the badge's contact point.
  if (isLead) {
    const r = easeOut(seg(t, hit, hit + .3)) * (w + 400);
    ctx.save(); ctx.beginPath(); ctx.rect(3, 3, w - 6, 47); ctx.clip(); ctx.fillStyle = P.red; ctx.beginPath(); ctx.arc(330, 26, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  txt(isLead ? 'LEADER-AGENT' : 'PI-AGENT', 20, 28, { size: 26, color: P.white });
  ctx.save(); ctx.beginPath(); ctx.rect(3, 55, w - 6, h - 58); ctx.clip();
  // The submitted request travels from the input box into the transcript.
  if (t >= B.enter) {
    const k = easeOut(seg(t, B.enter, B.enter + .25)), yy = lerp(h - 82, 100, k);
    ctx.fillStyle = P.concrete; ctx.fillRect(24, yy - 25, Math.min(w - 48, 640), 50);
    txt(TL.PROMPT, 40, yy, { size: 20, font: MONO, weight: 700 });
  }
  LOG.forEach((e, i) => {
    if (t < e.at) return;
    const ly = LOG_Y[i];
    if (e.out) txt(e.out, 30, ly, { size: 20, font: MONO, weight: 700, alpha: ease(seg(t, e.at, e.at + .25)) });
    else { codeLines(e.lines, 30, ly, t, e.at, { size: 20, cps: e.cps }); sourceGlow(t, typedDone(e.lines, e.at, e.cps) + 4 * F, 20, ly - 16, w - 40, e.lines.length * 30 + 2); }
  });
  // Status: a blocking wait, then a return.
  const waiting = t >= B.syncCall + .4 && (t < B.returned || t >= B.syncAgain + .4);
  const returned = t >= B.returned && t < B.syncAgain + .4;
  const sy = h - 172;
  if (waiting || returned) {
    ctx.fillStyle = returned ? P.concrete : P.ink; ctx.fillRect(20, sy, w - 40, 40);
    txt(returned ? '✓ team_sync RETURNED · 3 CHANGES' : '⏸ BLOCKING WAIT · team_sync', 36, sy + 21, { size: 20, font: TECH, weight: 700, color: returned ? P.ink : P.white, ls: 1 });
  }
  // Input box: soft typing, then an Enter that depresses and submits.
  const IY = h - 120, press = t >= B.enter && t < B.enter + 2 * F ? 4 : 0;
  ctx.strokeStyle = P.grey; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(20, IY + press); ctx.lineTo(w - 20, IY + press); ctx.moveTo(20, IY + 76 + press); ctx.lineTo(w - 20, IY + 76 + press); ctx.stroke();
  txt('>', 34, IY + 39 + press, { size: 26, font: MONO, weight: 700, color: P.red });
  const n = t < B.enter ? B.prompt.filter(x => x <= t).length : 0, typed = TL.PROMPT.slice(0, n);
  txt(typed, 66, IY + 39 + press, { size: 24, font: MONO, weight: 700 });
  if (Math.floor(t * 2.5) % 2 === 0) { ctx.fillStyle = P.red; ctx.fillRect(70 + measure(typed, 24, MONO, 700), IY + 25 + press, 13, 28); }
  const kk = seg(t, B.enter - .5, B.enter - .3) * (1 - seg(t, B.enter + .3, B.enter + .5));
  if (kk > 0) {
    const kx = Math.min(w - 110, 66 + measure(TL.PROMPT, 24, MONO, 700) + 80), kp = press * 1.5;
    ctx.save(); ctx.globalAlpha *= kk; box(kx - 60 + kp, IY + 10 + kp, 120, 56, { fill: P.white, shadow: 6 - kp, lw: 4 }); txt('⏎ ENTER', kx + kp, IY + 40 + kp, { size: 18, align: 'center' }); ctx.restore();
  }
  ctx.restore();
  if (c.flash) { ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.fillRect(0, 0, w, h); }
  ctx.restore();
}

// ---------- scene: cold open (pi-agent tabs) ----------
// Each tab is one pi-agent TUI asking for the user. The active tab lifts in its colour and slides;
// the content swaps only when the tab lands, entering from the side the tab moved toward.
const TAB_COLORS = [P.cyan, P.orange, P.yellow, P.blue];
const TOOL_LINES = [
  ['✓ read src/auth.test.ts', '✗ npm test · 3 failed', '↻ retry 4 of 4'],
  ['✓ read src/settings.ts', '✓ plan: add theme field', '? write needs approval'],
  ['✓ read docs/api.md', '✓ found v1 and v2 routes', '? which one is current'],
  ['✓ read 38 files', '✓ edit billing/invoice.ts', '! context near limit'],
];
const CW = { X: 90, Y: 110, Wd: 1740, Ht: 900 };
const tabX = i => CW.X + 24 + i * 424;
function tabState(tf) {
  const idx = TL.tabs.findLastIndex(([a]) => a <= tf), [ts, active, d] = TL.tabs[idx];
  const prev = idx > 0 ? TL.tabs[idx - 1][1] : active, sw = Math.min(.14, d * .45);
  return { active, prev, ts, sw, k: idx > 0 ? mj(seg(tf, ts, ts + sw)) : 1 };
}
function tuiContent(i, x0, y0, tf) {
  const { X, Y, Wd, Ht } = CW, d = TL.demands[i], col = TAB_COLORS[i];
  ctx.save(); ctx.translate(x0, y0);
  // pi header
  box(X + 40, Y + 124, 56, 56, { fill: P.ink, shadow: 0, lw: 0 }); txt('π', X + 68, Y + 154, { size: 40, align: 'center', color: P.white, font: TECH, weight: 700 });
  txt('pi', X + 112, Y + 154, { size: 38 });
  txt('esc interrupt  ·  / commands  ·  ctrl+c clear', X + 180, Y + 156, { size: 22, font: TECH, weight: 500, color: P.grey });
  ctx.save(); ctx.strokeStyle = P.concrete; ctx.lineWidth = 3; ctx.setLineDash([10, 8]); ctx.beginPath(); ctx.moveTo(X + 40, Y + 206); ctx.lineTo(X + Wd - 40, Y + 206); ctx.stroke(); ctx.restore();
  // transcript: the user's request, the agent's tool lines, then its question
  const um = measure('> ' + d.user, 26, MONO, 700);
  ctx.fillStyle = P.concrete; ctx.fillRect(X + 40, Y + 232, um + 48, 56);
  txt('> ' + d.user, X + 64, Y + 261, { size: 26, font: MONO, weight: 700 });
  TOOL_LINES[i].forEach((l, j) => txt(l, X + 64, Y + 330 + j * 40, { size: 23, font: MONO, weight: 500, color: j === 2 ? P.ink : P.grey }));
  const bx = X + 40, by = Y + 470, bw = 1060, bh = 200;
  ctx.fillStyle = P.ink; ctx.beginPath(); ctx.moveTo(bx + 60, by + bh - 4); ctx.lineTo(bx + 60, by + bh + 44); ctx.lineTo(bx + 120, by + bh - 4); ctx.fill();
  box(bx, by, bw, bh, { fill: P.white, shadow: 12, lw: 6 });
  ctx.fillStyle = col; ctx.fillRect(bx + 3, by + 3, 26, bh - 6);
  ctx.fillStyle = P.white; ctx.beginPath(); ctx.moveTo(bx + 66, by + bh - 3); ctx.lineTo(bx + 66, by + bh + 30); ctx.lineTo(bx + 110, by + bh - 3); ctx.fill();
  d.ask.forEach((l, j) => txt(l, bx + 64, by + 70 + j * 76, { size: 60, font: TECH, weight: 700 }));
  const pr = 1 + .12 * Math.sin(tf * 10);
  ctx.save(); ctx.translate(bx + bw - 10, by + 8); ctx.scale(pr, pr); ctx.beginPath(); ctx.arc(0, 0, 30, 0, Math.PI * 2); ctx.fillStyle = P.red; ctx.fill(); ctx.lineWidth = 5; ctx.strokeStyle = P.ink; ctx.stroke(); txt('!', 0, 3, { size: 38, align: 'center', color: P.white }); ctx.restore();
  // empty input box and footer
  const IY = Y + Ht - 170;
  ctx.strokeStyle = P.grey; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(X + 40, IY); ctx.lineTo(X + Wd - 40, IY); ctx.moveTo(X + 40, IY + 76); ctx.lineTo(X + Wd - 40, IY + 76); ctx.stroke();
  txt('>', X + 56, IY + 39, { size: 28, font: MONO, weight: 700, color: P.red });
  if (Math.floor(tf * 2.5) % 2 === 0) { ctx.fillStyle = P.red; ctx.fillRect(X + 92, IY + 24, 14, 30); }
  const foot = `~/app/${d.tab}  ·  standard  ·  ctx `;
  txt(foot, X + 56, IY + 118, { size: 21, font: MONO, weight: 500, color: P.grey });
  txt(d.ctx + '%', X + 56 + measure(foot, 21, MONO, 500), IY + 118, { size: 21, font: MONO, weight: 700, color: d.ctx >= 90 ? P.red : P.grey });
  ctx.restore();
}
function coldWindow(t) {
  const tf = Math.min(t, B.freeze), { active, prev, ts, sw, k } = tabState(tf), { X, Y, Wd, Ht } = CW;
  box(X, Y, Wd, Ht, { fill: P.white, shadow: 14, lw: 6 });
  ctx.fillStyle = P.concrete; ctx.fillRect(X + 3, Y + 3, Wd - 6, 97);
  // idle tabs with pulsing unread badges
  TL.demands.forEach((d, i) => {
    const tx = tabX(i);
    box(tx, Y + 20, 400, 80, { fill: P.ground, shadow: 0, lw: 4, ch: 14 });
    txt('PI-AGENT · ' + d.tab.toUpperCase(), tx + 24, Y + 62, { size: 24, color: P.grey });
    const count = 1 + Math.floor(tf * (1.2 + i * .4)) % 9, pr = 1 + .15 * Math.sin(tf * 12 + i);
    ctx.save(); ctx.translate(tx + 364, Y + 60); ctx.scale(pr, pr); ctx.beginPath(); ctx.arc(0, 0, 19, 0, Math.PI * 2); ctx.fillStyle = TAB_COLORS[i]; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = P.ink; ctx.stroke(); txt(String(count), 0, 1, { size: 20, align: 'center', color: ON(TAB_COLORS[i]) }); ctx.restore();
  });
  ctx.strokeStyle = P.ink; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(X, Y + 100); ctx.lineTo(X + Wd, Y + 100); ctx.stroke();
  // the active tab slides from the previous tab and lifts in its colour
  const ax = lerp(tabX(prev), tabX(active), k), col = TAB_COLORS[k < .5 ? prev : active], name = TL.demands[k < .5 ? prev : active].tab;
  box(ax, Y + 6, 400, 97, { fill: col, shadow: 8, lw: 5, ch: 14 });
  ctx.fillStyle = col; ctx.fillRect(ax + 3, Y + 90, 394, 14);
  txt('PI-AGENT · ' + name.toUpperCase(), ax + 24, Y + 56, { size: 28, color: ON(col) });
  // content enters from the side the tab moved toward, once the tab lands
  ctx.save(); ctx.beginPath(); ctx.rect(X + 3, Y + 104, Wd - 6, Ht - 107); ctx.clip();
  const shown = k < 1 ? prev : active, dir = Math.sign(active - prev) || 1;
  const e = easeOut(seg(tf, ts + sw, ts + sw + .12)), dx = k < 1 ? 0 : dir * 90 * (1 - e);
  tuiContent(shown, dx, 0, tf);
  ctx.restore();
}
const BANNER = { cx: 960, cy: 560, rot: -.04, size: 112, text: "LET'S ASSEMBLE A TEAM." };
function bannerParts() {
  const pre = "LET'S ASSEMBLE A ", word = 'TEAM', post = '.', s = BANNER.size;
  const total = measure(BANNER.text, s), x0 = -total / 2;
  return { pre, word, post, x0, wx: x0 + measure(pre, s), px: x0 + measure(pre + word, s), total };
}
// The stamp. In the title scene its phrase peels away and TEAM travels on (see teamWordPose).
function drawBanner(t, peel) {
  const k = seg(t, B.stamp - 3 * F, B.stamp); if (k <= 0) return;
  const c = contact(t, B.stamp, 'decision'), bp = bannerParts(), s = BANNER.size;
  const sc = t < B.stamp ? lerp(1.5, 1.04, easeIn(k)) : c.s, pk = easeInOut(clamp(peel * 2.2));
  ctx.save(); ctx.translate(BANNER.cx, BANNER.cy); ctx.rotate(BANNER.rot); ctx.scale(sc, sc);
  ctx.save(); ctx.globalAlpha *= 1 - seg(peel, .3, .6);
  box(lerp(-bp.total / 2 - 60, bp.wx - 20, pk), -100, lerp(bp.total + 120, measure(bp.word, s) + 40, pk), 200, { fill: P.ink, shadow: 14, shadowColor: P.red, lw: 0 });
  ctx.restore();
  const fall = (dx, str, i) => { const u = clamp(peel * 1.8 - i * .1); ctx.save(); ctx.translate(dx + measure(str, s) / 2, 6 + 900 * u * u); ctx.rotate(u * (i ? .5 : -.4)); ctx.globalAlpha *= 1 - u; txt(str, 0, 0, { size: s, align: 'center', color: P.white }); ctx.restore(); };
  fall(bp.x0, bp.pre, 0); fall(bp.px, bp.post, 1);
  if (peel <= 0) txt(bp.word, bp.wx, 6, { size: s, color: P.red });
  ctx.restore();
  if (c.flash) { ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.fillRect(0, 0, W, H); }
}
function sCold(t) {
  background(); groundHatch(t);
  coldWindow(t);
  const g = ease(seg(t, B.freeze, B.freeze + .2));
  if (g > 0) { ctx.fillStyle = `rgba(242,243,241,${.72 * g})`; ctx.fillRect(0, 0, W, H); }
  drawBanner(t, 0);
}

// ---------- scene: title (TEAM carries over, PI joins) ----------
const TITLE = { x: 110, y: 330, size: 210 };
function teamWordPose(t) {
  const bp = bannerParts(), u = mj(seg(t, B.peel, B.teamLand));
  const cr = Math.cos(BANNER.rot), sr = Math.sin(BANNER.rot);
  const bx = BANNER.cx + bp.wx * cr - 6 * sr, by = BANNER.cy + bp.wx * sr + 6 * cr;
  const tx = TITLE.x + measure('PI ', TITLE.size, DISPLAY, 400, -4), ty = TITLE.y;
  const rec = t > B.piHit ? 14 * Math.exp(-(t - B.piHit) * 14) * Math.cos((t - B.piHit) * 18) : 0;
  return { x: lerp(bx, tx, u) + rec, y: lerp(by, ty, u), size: lerp(BANNER.size, TITLE.size, u), rot: lerp(BANNER.rot, 0, u), red: 1 - seg(u, .5, 1) };
}
function titleLayer(t, fade = 0) {
  ctx.save(); ctx.globalAlpha *= 1 - fade;
  const slab = (x, w, c, k) => { if (k <= 0) return; ctx.fillStyle = c; const dx = (1 - easeOut(k)) * 900; ctx.beginPath(); ctx.moveTo(x + dx, H); ctx.lineTo(x + dx + H * .58, 0); ctx.lineTo(x + dx + H * .58 + w, 0); ctx.lineTo(x + dx + w, H); ctx.fill(); };
  slab(1090, 160, P.concrete, seg(t, B.bright, B.bright + .3)); slab(1290, 44, P.red, seg(t, B.bright + .1, B.bright + .4)); slab(1374, 18, P.ink, seg(t, B.bright + .2, B.bright + .5)); slab(1430, 480, P.white, seg(t, B.bright + .05, B.bright + .35));
  glyph(1430, 320, 200, seg(t, B.glyph, B.glyph + .35));
  const p = teamWordPose(t), c = contact(t, B.teamLand);
  ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(c.s, c.s);
  const ls = lerp(0, -4, seg(p.size, BANNER.size, TITLE.size));
  txt('TEAM', 0, 0, { size: p.size, ls, color: P.ink });
  if (p.red > 0) txt('TEAM', 0, 0, { size: p.size, ls, color: P.red, alpha: p.red });
  ctx.restore();
  const bk = seg(t, B.bright - 5 * F, B.bright);
  if (bk > 0) {
    const bc = contact(t, B.bright), y = lerp(-300, 440, easeIn(bk));
    ctx.save(); ctx.translate(596, y + 125); ctx.scale(1, bc.s); ctx.translate(-500, -125);
    box(0, 0, 1000, 250, { fill: P.red, shadow: 14 * bc.sh, lw: 6 }); txt('BRIGHT', 34, 135, { size: 210, ls: -4, color: P.white });
    ctx.restore();
  }
  ['ONE LEAD.', 'A VISIBLE TEAM.', 'WORK YOU CAN PROVE.'].forEach((l, i) => {
    const st = B.tagline[i];
    sticker(l, 110 + measure(l, 40) / 2 + 24 + i * 34, 790 + i * 82, { size: 40, bg: [P.white, P.white, P.ink][i], k: seg(t, st, st + .3), shadow: 7, shadowColor: i === 2 ? P.red : P.ink });
  });
  ctx.restore();
}
function sTitle(t) {
  background(); groundHatch(t);
  const bg = 1 - ease(seg(t, B.peel, B.peel + .4));
  if (bg > 0) { ctx.save(); ctx.globalAlpha = bg; coldWindow(B.freeze); ctx.fillStyle = 'rgba(242,243,241,.72)'; ctx.fillRect(0, 0, W, H); ctx.restore(); }
  drawBanner(t, seg(t, B.peel, B.peel + .5));
  titleLayer(t);
  const u = mj(seg(t, B.teamLand, B.piHit)), c = contact(t, B.piHit);
  ctx.save(); ctx.translate(lerp(-520, TITLE.x, u), TITLE.y); ctx.scale(c.s, c.s); txt('PI', 0, 0, { size: TITLE.size, ls: -4 }); ctx.restore();
}

// ---------- brand glyph ----------
// The brand mark pops in; (x, y) is its left-middle point and s its height.
function glyph(x, y, s, k = 1) {
  if (k <= 0) return;
  const sc = backOut(k); ctx.save(); ctx.translate(x, y); ctx.scale(sc, sc); BR.mark(ctx, 0, -s / 2, s); ctx.restore();
}

// ---------- the world: team → graph → lead → review → timeline ----------
function world(t) {
  const [, S] = sceneAt('team');
  background(); groundHatch(t);
  ctx.save(); applyCam(camAt(t));
  const tabA = seg(t, S + .5, S + .8) * (1 - seg(t, B.relayout[0], B.relayout[0] + .5));
  if (tabA > 0) { ctx.save(); ctx.globalAlpha = tabA; box(...TAB, { fill: P.concrete, shadow: 14, lw: 6 }); ctx.restore(); }
  // Empty worker slots receive the header tabs.
  const slotA = seg(t, B.shrink[1] - .2, B.shrink[1] + .1);
  if (slotA > 0) TL.workers.forEach((_, i) => {
    if (t >= B.workerLand[i] + .4) return;
    const [x, y, w, h] = workerRect(i, t); ctx.save(); ctx.globalAlpha = slotA * .6; ctx.setLineDash([14, 10]); ctx.strokeStyle = P.grey; ctx.lineWidth = 3; ctx.strokeRect(x, y, w, h); ctx.restore();
  });
  const morphing = t >= B.keyV;
  if (!morphing) { dagEdges(t); for (const key of Object.keys(POS)) ticket(key, ...tpos(key), t); dagTokens(t); }
  const out = easeIn(seg(t, ...B.panesOut));
  ctx.save(); ctx.translate(out * 900, 0);
  TL.workers.forEach((_, i) => workerPane(i, t, { alpha: 1 - out }));
  ctx.restore();
  if (t < B.keyV + .6) { ctx.save(); ctx.globalAlpha = 1 - seg(t, B.keyV, B.keyV + .6); leadPane(t); ctx.restore(); }
  worldCarriers(t);
  worldStickers(t);
  if (morphing) timelineMorph(t);
  ctx.restore();
}
function worldCarriers(t) {
  { const [lx, ly] = leadRect(t); carrier(t, ...B.badge, logAnchor(0, t), [lx + 330, ly + 26], 'badge', P.red, 'TEAM', .3); }
  TL.workers.forEach((wk, i) => {
    const e = LOG[i + 1], t0 = typedDone(e.lines, e.at, e.cps) + 4 * F, [x, y, w] = workerRect(i, t);
    carrier(t, t0, B.workerLand[i], logAnchor(i + 1, t), [x + w / 2, y + 20], 'tab', WC[wk.name], wk.name + '-agent', .25);
  });
  const gi = logIndex(B.graphApply);
  Object.keys(POS).forEach((key, i) => { const t0 = B.unfoldTickets + i * .1; carrier(t, t0, t0 + .45, logAnchor(gi, t), tpos(key), 'mini', WC[TL.tasks[key].worker], null, .2); });
  for (const cr of SCHED_CARRIERS) {
    const tp = tpos(cr.key), pp = paneCenter(cr.worker, t);
    if (cr.dir === 'toPane') {
      const g = seg(t, cr.t0 - 4 * F, cr.t0) * (1 - seg(t, cr.t0, cr.t0 + 6 * F));
      if (g > 0) { ctx.save(); ctx.globalAlpha = .6 * g; ctx.strokeStyle = P.red; ctx.lineWidth = 8; ctx.strokeRect(tp[0] - TW / 2 - 10, tp[1] - TH / 2 - 10, TW + 20, TH + 20); ctx.restore(); }
      carrier(t, cr.t0, cr.t1, tp, pp, 'deliver', WC[cr.worker], null, .15);
    } else carrier(t, cr.t0, cr.t1, pp, tp, 'slip', null, cr.label, .15);
  }
  const [bm, b0, b1] = B.batch;
  TL.changes.forEach(([key, state, tc], i) => {
    const color = state === 'blocked' ? P.yellow : P.green, slot = [TRAY[0], TRAY[1] - 40 + i * 40];
    carrier(t, tc + .1, tc + .7, tpos(key), slot, 'change', color, null, .12);
    if (t >= tc + .7 && t < bm + .3) { const k = ease(seg(t, bm, bm + .3)); ctx.save(); ctx.globalAlpha = 1 - k; ctx.translate(slot[0], lerp(slot[1], TRAY[1], k)); carrierShape('change', color); ctx.restore(); }
  });
  if (t >= bm + .2 && t < b0) { ctx.save(); ctx.translate(...TRAY); carrierShape('envelope', P.ink, '3'); ctx.restore(); }
  { const [lx, ly, , lh] = leadRect(t); carrier(t, b0, b1, TRAY, [lx + 300, ly + lh - 152], 'envelope', P.ink, '3', .25); }
  carrier(t, ...B.alert, logAnchor(logIndex(B.alertType), t), paneCenter('ui', t), 'envelope', P.red, '', .22);
}
function worldStickers(t) {
  const n = TL.changes.filter(([, , tc]) => t >= tc + .7).length;
  if (n > 0 && t < B.batch[0] + .3) sticker(`${n} CHANGE${n > 1 ? 'S' : ''}`, TRAY[0], TRAY[1] + 110, { size: 20, bg: P.white, shadow: 4, lw: 3, noPop: true });
  const [lx, ly, lw, lh] = leadRect(t);
  if (t < B.keyV) sticker('TEAM · RELEASE', lx + 400, ly - 6, { size: 26, bg: P.red, k: seg(t, B.badge[1] + .15, B.badge[1] + .45), rot: -.03 });
  const dk = ease(seg(t, B.dims, B.dims + .4)) * (1 - seg(t, B.relayout[0], B.relayout[0] + .4));
  if (dk > 0) {
    const [LX, , LW] = LEAD, RX = 796, RW = 1044, y = TAB[1] - 22;
    ctx.save(); ctx.globalAlpha = dk; ctx.strokeStyle = P.red; ctx.lineWidth = 4;
    [[LX + 300, LX + LW, 'LEADER AGENT'], [RX, RX + RW, 'WORKER AGENTS']].forEach(([x1, x2, s]) => {
      ctx.beginPath(); ctx.moveTo(x1, y - 12); ctx.lineTo(x1, y + 12); ctx.moveTo(x2, y - 12); ctx.lineTo(x2, y + 12); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
      const tw = measure(s, 24, TECH, 700, 2) + 28; ctx.fillStyle = P.ground; ctx.fillRect((x1 + x2) / 2 - tw / 2, y - 18, tw, 36);
      txt(s, (x1 + x2) / 2, y + 1, { size: 24, font: TECH, weight: 700, align: 'center', color: P.red, ls: 2 });
    });
    sticker('TMUX / HERDR MULTIPLEXER INTEGRATED', RX + RW / 2, TAB[1] + TAB[3], { size: 26, bg: P.white, k: seg(t, B.dims + .3, B.dims + .6), rot: -.02 });
    ctx.restore();
  }
  const nk = seg(t, B.waitNote, B.waitNote + .3) * (1 - seg(t, B.batch[0], B.batch[0] + .3));
  if (nk > 0) sticker('no sleep-and-recheck · a Task change returns the call', lx + lw / 2, ly + lh - 215, { size: 19, font: MONO, weight: 700, bg: P.white, k: nk, rot: -.02, shadow: 5 });
  const uk = Math.min(ease(seg(t, B.unchanged[0], B.unchanged[0] + .3)), 1 - ease(seg(t, B.unchanged[1] - .3, B.unchanged[1])));
  if (uk > 0) { const [x, y] = tpos('ui'); sticker('TASK STATE UNCHANGED', x, y - TH / 2 - 40, { size: 22, bg: P.ink, shadowColor: P.red, k: uk, rot: .02 }); }
}

// ---------- timeline morph (world space, DAG camera) ----------
const TLF = [1050, 200, 1620, 790];
function attemptRows() {
  const rows = [];
  for (const [key, task] of Object.entries(TL.tasks)) {
    let cur = null, n = 0;
    for (const [at, s, note] of task.schedule) {
      if (s === 'run' && note !== 'resumed') { if (cur) rows.push(cur); n++; cur = { key, n, segs: [] }; }
      if (cur) cur.segs.push([at, s]);
    }
    if (cur) rows.push(cur);
  }
  return rows;
}
function timelineMorph(t) {
  const [X, Y, Wd, Ht] = TLF, gx = 330, gw = Wd - gx - 70, rowH = 90, gy = 110;
  const [t0, t1] = B.tlSpan, sx = v => X + gx + (v - t0) / (t1 - t0) * gw;
  const rows = attemptRows(), un = easeOut(seg(t, ...B.unfoldRows));
  const ys = []; let acc = Y + gy; rows.forEach(r => { const h = r.n > 1 ? rowH * un : rowH; ys.push([acc, h]); acc += h; });
  dagEdges(t, 1 - ease(seg(t, B.keyV, B.morph[0])));
  const fk = ease(seg(t, ...B.frame));
  if (fk > 0) {
    ctx.save(); ctx.beginPath(); ctx.rect(X - 20, Y - 20, (Wd + 60) * fk, Ht + 60); ctx.clip(); pane(X, Y, Wd, Ht, 'Task graph · timeline', P.ink);
    ctx.strokeStyle = 'rgba(27,29,32,.12)'; ctx.lineWidth = 2;
    for (let v = Math.ceil(t0); v <= t1; v += 2) { ctx.beginPath(); ctx.moveTo(sx(v), Y + gy - 20); ctx.lineTo(sx(v), acc); ctx.stroke(); }
    ctx.restore();
  }
  rows.forEach((r, i) => {
    const [y, h] = ys[i]; if (h < 4) return;
    const labelK = r.n > 1 ? un : seg(t, B.morph[0] + .5, B.morph[1]);
    ctx.save(); ctx.beginPath(); ctx.rect(X, y, Wd, h); ctx.clip();
    txt(`${r.key}${r.n > 1 ? ' #' + r.n : ''}`, X + 40, y + rowH / 2, { size: 30, alpha: labelK });
    txt('@' + TL.tasks[r.key].worker, X + 215, y + rowH / 2, { size: 19, font: TECH, weight: 700, color: P.grey, alpha: labelK });
    ctx.restore();
  });
  const reveal = lerp(t0, t1, easeOut(seg(t, ...B.reveal)));
  if (t >= B.reveal[0]) {
    rows.forEach((r, i) => {
      const [y, h] = ys[i]; if (h < rowH * .9) return;
      for (let j = 0; j < r.segs.length; j++) {
        const [s0, st] = r.segs[j];
        if (st !== 'run' && st !== 'blocked') continue;
        const e = r.segs[j + 1] ? r.segs[j + 1][0] : s0 + .5, x1 = sx(s0), x2 = sx(Math.min(e, reveal));
        if (x2 <= x1) continue;
        box(x1, y + 18, x2 - x1, rowH - 36, { fill: st === 'blocked' ? P.concrete : WC[TL.tasks[r.key].worker], shadow: 5, lw: 4, hatch: st === 'blocked' ? { alpha: .35, gap: 16, lw: 6 } : null });
      }
      const fin = r.segs.find(([, s]) => s === 'ok' || s === 'failed');
      if (fin && reveal >= fin[0]) txt(fin[1] === 'ok' ? '✓' : '✗', sx(fin[0]) + 22, y + rowH / 2, { size: 32, color: fin[1] === 'ok' ? '#3E9A2C' : P.red });
    });
    ctx.fillStyle = P.red; ctx.fillRect(sx(reveal) - 3, Y + gy - 30, 6, acc - Y - gy + 30);
  }
  // Tickets fly into their parent row and hand it their name.
  Object.keys(POS).forEach((key, i) => {
    const k = easeInOut(seg(t, B.morph[0] + i * .06, B.morph[1] - .2 + i * .06));
    if (k >= 1) return;
    const ri = rows.findIndex(r => r.key === key && r.n === 1), from = tpos(key), to = [X + 40 + measure(key, 30) / 2, ys[ri][0] + rowH / 2];
    ctx.save(); ctx.globalAlpha *= 1 - seg(k, .75, 1);
    ctx.translate(lerp(from[0], to[0], k), lerp(from[1], to[1], k)); const s = lerp(1, .28, k); ctx.scale(s, s);
    ticket(key, 0, 0, t, { force: true, noStamp: k > .1, noNote: k > .05 });
    ctx.restore();
  });
}

// ---------- scenes ----------
function sTeam(t) {
  const [, S] = sceneAt('team');
  if (t >= S + .7) { world(t); return; }
  // PI carries from the title into the pane header while the pane unfolds around it.
  background(); groundHatch(t);
  const k = seg(t, S, S + .7), u = mj(k);
  titleLayer(t, easeIn(clamp(k * 2)));
  const [fx, fy, fw, fh] = LEAD_FULL, piW = measure('PI', TITLE.size, DISPLAY, 400, -4);
  const r = [lerp(TITLE.x - 10, fx, u), lerp(TITLE.y - 110, fy, u), lerp(piW + 20, fw, u), lerp(220, fh, u)];
  if (u > .05) { ctx.save(); ctx.globalAlpha = clamp(u * 3); pane(r[0], r[1], r[2], r[3], null, P.ink, { shadow: 8, head: lerp(220, 52, u) }); ctx.restore(); }
  const size = lerp(TITLE.size, 26, u);
  const px = lerp(TITLE.x, fx + 20, u), py = lerp(TITLE.y, fy + 28, u);
  txt('PI', px, py, { size, ls: lerp(-4, 0, u), color: u > .35 ? P.white : P.ink });
  if (u > .8) txt('-AGENT', px + measure('PI', 26), py, { size: 26, color: P.white, alpha: seg(u, .8, 1) });
}
function sEnd(t) {
  background(); groundHatch(t);
  const k = seg(t, B.logo, B.logo + .35);
  if (k > 0) { // the brand lockup, as on every other surface
    const size = 104, lw = BR.lockupWidth(ctx, size), sc = backOut(k);
    ctx.save(); ctx.globalAlpha *= clamp(k * 3); ctx.translate(W / 2, 300); ctx.scale(sc, sc); BR.lockup(ctx, -lw / 2, 0, size); ctx.restore();
  }
  const chips = ['VISIBLE WORKERS', 'MODEL ROLES', 'DAG-NATIVE', 'ROBUST TASK & MESSAGE ENGINE'];
  const widths = chips.map(c => measure(c, 30) + 40), gap = 26;
  let x = W / 2 - (widths.reduce((p, v) => p + v, 0) + gap * (chips.length - 1)) / 2;
  ctx.save(); ctx.globalAlpha = ease(seg(t, B.logo + .3, B.logo + .6));
  chips.forEach((c, i) => { sticker(c, x + widths[i] / 2, 470, { size: 30, bg: i === 3 ? P.ink : P.white, shadowColor: i === 3 ? P.red : P.ink, shadow: 6, lw: 4, noPop: true }); x += widths[i] + gap; });
  ctx.restore();
  box(310, 600, 1300, 116, { fill: P.ink, shadow: 12, shadowColor: P.red, lw: 0 });
  txt('$ pi install npm:@hypercarrier/pi-team-bright', 350, 660, { size: 40, font: MONO, weight: 500, color: P.white });
  txt('github.com/deephbz/pi-team-bright  ·  MIT', W / 2, 820, { size: 32, font: TECH, weight: 700, align: 'center', ls: 2, alpha: ease(seg(t, B.logo + .8, B.logo + 1.2)) });
}

// ---------- compositor ----------
const SCENES = { cold: sCold, title: sTitle, team: sTeam, graph: world, lead: world, review: world, timeline: world, end: sEnd };
const PUSH = .4, SLANT = H * Math.tan(Math.PI / 6);
function drawScene(name, t) { ctx.save(); SCENES[name](t); ctx.restore(); }
function renderFrame(t) {
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  const i = TL.scenes.findIndex(([, a, b]) => t >= a && t < b), idx = i < 0 ? TL.scenes.length - 1 : i;
  const cur = TL.scenes[idx], next = TL.scenes[idx + 1];
  let cut = null;
  if (next && TL.pushIn.includes(next[0]) && t > next[1] - PUSH) cut = [cur[0], next[0], next[1]];
  else if (idx > 0 && TL.pushIn.includes(cur[0]) && t < cur[1] + PUSH) cut = [TL.scenes[idx - 1][0], cur[0], cur[1]];
  const [sx, sy] = shake(t);
  ctx.save(); ctx.translate(sx, sy);
  if (!cut) drawScene(cur[0], t);
  else {
    const [from, to, c] = cut, p = easeInOut(seg(t, c - PUSH, c + PUSH)), x = lerp(W + 40, -SLANT - 40, p);
    const region = left => { ctx.beginPath(); if (left) { ctx.moveTo(-50, -50); ctx.lineTo(x + SLANT, -50); ctx.lineTo(x, H + 50); ctx.lineTo(-50, H + 50); } else { ctx.moveTo(x + SLANT, -50); ctx.lineTo(W + 50, -50); ctx.lineTo(W + 50, H + 50); ctx.lineTo(x, H + 50); } ctx.closePath(); };
    ctx.save(); region(true); ctx.clip(); ctx.translate(-(1 - x / W) * 120, 0); drawScene(from, t); ctx.restore();
    ctx.save(); region(false); ctx.clip(); ctx.translate((x / W) * 120, 0); drawScene(to, t); ctx.restore();
    ctx.save(); ctx.strokeStyle = P.red; ctx.lineWidth = 22; ctx.beginPath(); ctx.moveTo(x + 18, H); ctx.lineTo(x + SLANT + 18, 0); ctx.stroke();
    ctx.strokeStyle = P.ink; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(x, H); ctx.lineTo(x + SLANT, 0); ctx.stroke(); ctx.restore();
  }
  ctx.restore();
  // Key cap V switches the view (screen space).
  const kk = seg(t, B.keyV - .3, B.keyV), press = t >= B.keyV && t < B.keyV + .15 ? 6 : 0, gone = ease(seg(t, B.reveal[1], B.reveal[1] + .3));
  if (kk > 0 && gone < 1 && t < sceneAt('end')[1]) {
    ctx.save(); ctx.globalAlpha = 1 - gone; ctx.translate(1790, 1000); const s = backOut(kk); ctx.scale(s, s);
    box(-50 + press, -50 + press, 100, 100, { fill: P.red, shadow: 10 - press, lw: 5 }); txt('V', press, press + 4, { size: 60, align: 'center', color: P.white });
    ctx.restore();
    ctx.save(); ctx.globalAlpha = 1 - gone; sticker('DAG ⇄ TIMELINE', 1590, 1000, { size: 26, bg: P.white, k: kk }); ctx.restore();
  }
  captions(t);
  const fade = Math.max(1 - seg(t, 0, .3), seg(t, TL.DUR - .9, TL.DUR - .1));
  if (fade > 0) { ctx.fillStyle = `rgba(242,243,241,${fade})`; ctx.fillRect(0, 0, W, H); }
}
window.renderAt = (t, type = 'image/jpeg', q = .93) => { renderFrame(t); return cv.toDataURL(type, q); };
Promise.all(['400 40px "Archivo Black"', '700 40px "Chakra Petch"', '500 40px "JetBrains Mono"', '700 40px "JetBrains Mono"'].map(f => document.fonts.load(f)))
  .then(() => document.fonts.ready).then(() => { renderFrame(0); window.ready = true; });
if (!location.search.includes('render')) {
  const sc = document.getElementById('scrub');
  sc.max = TL.DUR; sc.oninput = () => renderFrame(+sc.value);
}
