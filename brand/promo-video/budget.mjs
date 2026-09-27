// budget.mjs: check that every read in timeline.js holds long enough to be read.
//   node budget.mjs            table of reads with required and actual hold; exit 1 on a violation
//
// Rule source: Clearcast / BCAP superimposed-text hold: 0.2 s per word plus a recognition time of
// 2 s (up to 9 words) or 3 s (10 words or more). That rule governs 'super' reads and captions.
// House rules (provisional, tuned by owner review): a new in-picture element needs 0.2 s/word + 1.0 s;
// a repeat of a pattern the viewer already knows needs 0.2 s/word + 0.6 s.
import { readFileSync } from 'node:fs';
new Function(readFileSync('timeline.js', 'utf8'))();
const TL = globalThis.TL;
const words = s => s.split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w)).length;
const need = (s, kind) => {
  const n = words(s);
  return n * .2 + (kind === 'super' ? (n >= 10 ? 3 : 2) : kind === 'new' ? 1 : .6);
};
const rows = [...TL.captions.map(([s, a, b]) => [s, a, b, 'caption']), ...TL.reads].sort((x, y) => x[1] - y[1]);
let bad = 0;
for (const [s, a, b, kind] of rows) {
  const req = need(s, kind === 'caption' ? 'super' : kind), hold = b - a, ok = hold >= req - 1e-6;
  if (!ok) bad++;
  console.log(`${ok ? '  ' : '✗ '}${a.toFixed(2).padStart(6)}  ${hold.toFixed(2).padStart(5)} / ${req.toFixed(2).padStart(5)}  ${kind.padEnd(7)} ${s.slice(0, 70)}`);
}
console.log(`${rows.length} reads, ${bad} short · duration ${TL.DUR}s`);
process.exit(bad ? 1 : 0);
