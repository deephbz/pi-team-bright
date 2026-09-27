// music.mjs: synthesize assets/soundtrack.wav from timeline.js. No samples, no external models.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
new Function(readFileSync('timeline.js', 'utf8'))();
const TL = globalThis.TL, SR = 44100, N = Math.ceil(TL.DUR * SR), B = TL.BEAT, BAR = B * 4;
const L = new Float32Array(N), R = new Float32Array(N);
const start = name => TL.scenes.find(s => s[0] === name)[1];
const DROP = start('title'), OUTRO = start('end');
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 * 2 - 1;

// Add a mono voice fn(tau) → sample over [t0, t0+len) with pan in [-1, 1].
function add(t0, len, fn, gain = 1, pan = 0) {
  const i0 = Math.max(0, Math.floor(t0 * SR)), i1 = Math.min(N, Math.floor((t0 + len) * SR));
  const gl = gain * Math.sqrt((1 - pan) / 2), gr = gain * Math.sqrt((1 + pan) / 2);
  for (let i = i0; i < i1; i++) { const v = fn((i - t0 * SR) / SR); L[i] += v * gl; R[i] += v * gr; }
}
const kick = t0 => { let ph = 0; add(t0, .45, tau => { ph += (45 + 110 * Math.exp(-tau * 30)) / SR; return Math.sin(ph * 2 * Math.PI) * Math.exp(-tau * 7); }, .9); };
const snare = t0 => { let lp = 0; add(t0, .3, tau => { const n = rnd(); lp += .5 * (n - lp); return ((n - lp) * .7 * Math.exp(-tau * 16)) + Math.sin(2 * Math.PI * 190 * tau) * .4 * Math.exp(-tau * 25); }, .45); };
const hat = (t0, g = .12, pan = .3) => { let lp = 0; add(t0, .08, tau => { const n = rnd(); lp += .6 * (n - lp); return (n - lp) * Math.exp(-tau * 70); }, g, pan); };
const crash = t0 => { let lp = 0; add(t0, 2.4, tau => { const n = rnd(); lp += .4 * (n - lp); return (n - lp) * Math.exp(-tau * 1.8); }, .22); };
const pluck = (t0, m, g, pan) => { const f = mtof(m); add(t0, .5, tau => { const p = (tau * f) % 1; return (4 * Math.abs(p - .5) - 1) * Math.exp(-tau * 11); }, g, pan); };
const bassNote = (t0, m, len, g = .32, cut = .08) => { const f = mtof(m); let lp = 0;
  add(t0, len, tau => { const s = 2 * ((tau * f) % 1) - 1 + (2 * ((tau * f * 1.006) % 1) - 1); lp += cut * (s - lp); return lp * Math.min(1, tau * 200) * Math.exp(-tau * 3); }, g); };
const pad = (t0, len, notes, g = .05) => notes.forEach((m, j) => { const f = mtof(m);
  add(t0, len, tau => { const env = Math.min(1, tau / .6) * Math.min(1, (len - tau) / .5); return (Math.sin(2 * Math.PI * f * tau) + .5 * Math.sin(2 * Math.PI * f * 1.003 * tau + j)) * env; }, g, (j - 1) * .5); });
const chime = (t0, ms, g = .18) => ms.forEach((m, j) => { const f = mtof(m); add(t0 + j * .07, .9, tau => Math.sin(2 * Math.PI * f * tau) * Math.exp(-tau * 5) * (1 + .3 * Math.sin(2 * Math.PI * f * 2 * tau)), g, j ? .3 : -.3); });
const buzz = t0 => add(t0, .45, tau => { const f = 110 - 40 * tau; return (2 * ((tau * f) % 1) - 1) * Math.exp(-tau * 5) * .8; }, .25);
const blip = (t0, m = 84, g = .14) => { const f = mtof(m); add(t0, .15, tau => Math.sin(2 * Math.PI * f * tau) * Math.exp(-tau * 30), g); };

// Am – F – C – G, one chord per bar.
const PROG = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]], ROOT = [45, 41, 48, 43];

// Intro: tense pulse on A, tightening hats, rising noise into the drop.
for (let t = 0; t < DROP; t += B / 2) bassNote(t, 33, B / 2, .28, .03 + .05 * t / DROP);
for (let t = 0; t < DROP; t += B / 4) hat(t, .04 + .08 * t / DROP, .2);
for (let t = 0; t < DROP; t += B) blip(t, 93, .05);
// (Intro sound effects come from TL.cues below.)
{ let lp = 0; add(DROP - 1.6, 1.6, tau => { const n = rnd(); lp += (.02 + .3 * tau / 1.6) * (n - lp); return lp * Math.pow(tau / 1.6, 2); }, .5); }

// Main groove.
crash(DROP); crash(OUTRO);
for (let bar = 0, t = DROP; t < TL.DUR - .01; bar++, t += BAR) {
  const c = bar % 4, outro = t >= OUTRO;
  pad(t, BAR + .1, PROG[c].map(m => m + 12), outro ? .06 : .045);
  for (let e = 0; e < 8; e++) if (!outro || e % 2 === 0) bassNote(t + e * B / 2, ROOT[c] - 12, B / 2, outro ? .2 : .3);
  for (let b = 0; b < 4; b++) {
    const tb = t + b * B;
    if (!outro || tb < OUTRO + BAR) { kick(tb); hat(tb + B / 2, .1, .35); if (b % 2) snare(tb); }
    if (!outro && bar % 2) kick(tb + B * .75);
  }
  const arp = [...PROG[c], PROG[c][1] + 12];
  for (let s = 0; s < 16; s++) pluck(t + s * B / 4, arp[s % 4] + 12, outro ? .06 : .08, s % 2 ? .45 : -.45);
}

// Event sound effects: every cue comes from timeline.js, so sound follows picture.
const thud = (t0, g = .5) => { let ph = 0; add(t0, .3, tau => { ph += (60 + 90 * Math.exp(-tau * 40)) / SR; return Math.sin(ph * 2 * Math.PI) * Math.exp(-tau * 12); }, g); };
const swoosh = t0 => { let lp = 0; add(t0, .45, tau => { const n = rnd(); lp += (.05 + .5 * tau / .45) * (n - lp); return lp * Math.sin(Math.PI * tau / .45); }, .35, .2); };
const click = (t0, f = 2400, g = .06, len = .03) => { let lp = 0; add(t0, len, tau => { const n = rnd(); lp += .5 * (n - lp); return ((n - lp) * .7 + Math.sin(2 * Math.PI * f * tau) * .3) * Math.exp(-tau / len * 5); }, g, .1); };
// Music and effects mix separately so decisions can duck the music.
const ML = L.slice(), MR = R.slice(); L.fill(0); R.fill(0);
const SFX = {
  pop: t => chime(t, [79, 86], .1),
  slam: t => { thud(t, .55); snare(t); },
  stamp: t => { thud(t, .6); hat(t, .2, 0); },
  decision: t => { thud(t, .8); snare(t); hat(t, .25, 0); },
  land: t => { thud(t, .45); click(t, 1800, .08, .05); },
  ok: t => chime(t, [76, 83]),
  fail: buzz,
  block: t => { thud(t, .45); thud(t + .15, .35); },
  tick: t => blip(t, 88, .09),
  deliver: t => { click(t, 3200, .09); blip(t, 84, .07); },
  wake: t => chime(t, [72, 76, 79, 84], .15),
  alert: t => { blip(t, 81, .14); blip(t + .1, 88, .14); },
  key: t => { hat(t, .25, 0); blip(t, 96, .06); },
  type: t => click(t, 2600 + 900 * rnd(), .035),
  enter: t => { thud(t, .35); click(t, 1200, .14, .06); },
  tab: t => click(t, 1900, .07, .04),
  freeze: t => { let lp = 0; add(t, .25, tau => { const n = rnd(); lp += .2 * (n - lp); return lp * Math.exp(-tau * 14); }, .3); },
  swoosh,
};
for (const [t, kind] of TL.cues) SFX[kind](t);
const duck = x => TL.decisions.reduce((m, d) => Math.min(m, x < d - .02 || x > d + .6 ? 1 : .55 + .45 * Math.min(1, Math.max(0, (x - d) / .6))), 1);
for (let i = 0; i < N; i++) { const d = duck(i / SR); L[i] += ML[i] * d; R[i] += MR[i] * d; }

// Master: normalize, soft clip, fade the last second.
let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const fade = Math.min(1, (N - i) / SR);
  for (const [c, ch] of [[0, L], [1, R]]) buf.writeInt16LE(Math.round(Math.tanh(ch[i] / peak * 1.4) * .85 * fade * 32767), 44 + i * 4 + c * 2);
}
mkdirSync('assets', { recursive: true }); writeFileSync('assets/soundtrack.wav', buf);
console.log(`assets/soundtrack.wav  ${TL.DUR}s  peak ${peak.toFixed(2)}`);
