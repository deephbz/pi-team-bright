// build.mjs: derive every brand asset from brand.js.
//   node build.mjs              write assets/ (logo, mark, favicon set, banners, tokens.css)
//   node build.mjs --check      exit 1 if assets/ differs from a fresh build
//   node build.mjs --site DIR   write the website (index.html + assets + fonts) into DIR
//
// brand.js draws through a Canvas2D context. SvgContext implements the subset it uses, so the same
// drawing code yields vector assets here and video frames in the browser. Text becomes outlines
// from the vendored fonts, so no asset depends on installed fonts. resvg rasterizes the PNGs.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import { Resvg } from '@resvg/resvg-js';

const HERE = dirname(fileURLToPath(import.meta.url));
new Function(readFileSync(join(HERE, 'brand.js'), 'utf8'))();
const BR = globalThis.PTBBrand, C = BR.color;

// ---------- fonts ----------
const FONTS = {};
const loadFont = file => (FONTS[file] ??= opentype.parse(readFileSync(join(HERE, 'fonts', file)).buffer.slice(0)));
function fontFor(spec) {
  const m = /^(\d+)\s+([\d.]+)px\s+"([^"]+)"/.exec(spec); if (!m) throw new Error('unparsed font: ' + spec);
  const [, weight, size, family] = m, f = Object.values(BR.font).find(x => x.family === family);
  return { font: loadFont(f.file ?? f.weights[weight] ?? Object.values(f.weights)[0]), size: +size };
}

// ---------- SVG context (Canvas2D subset) ----------
const r2 = v => Math.round(v * 100) / 100;
class SvgContext {
  constructor() { this.out = []; this.path = []; this.st = { m: [1, 0, 0, 1, 0, 0], fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineJoin: 'miter', lineCap: 'butt', dash: [], globalAlpha: 1, font: '400 10px "Archivo Black"', textAlign: 'left', textBaseline: 'alphabetic', letterSpacing: '0px' }; this.stack = []; }
  save() { this.stack.push({ ...this.st, m: [...this.st.m], dash: [...this.st.dash] }); }
  restore() { this.st = this.stack.pop(); }
  transform(a, b, c, d, e, f) { const [A, B, Cc, D, E, F] = this.st.m; this.st.m = [A * a + Cc * b, B * a + D * b, A * c + Cc * d, B * c + D * d, A * e + Cc * f + E, B * e + D * f + F]; }
  translate(x, y) { this.transform(1, 0, 0, 1, x, y); }
  scale(x, y) { this.transform(x, 0, 0, y, 0, 0); }
  rotate(a) { const c = Math.cos(a), s = Math.sin(a); this.transform(c, s, -s, c, 0, 0); }
  pt(x, y) { const [a, b, c, d, e, f] = this.st.m; return [a * x + c * y + e, b * x + d * y + f]; }
  get unit() { const [a, b, c, d] = this.st.m; return Math.sqrt(Math.abs(a * d - b * c)); }
  // Style properties map straight onto the state.
  set fillStyle(v) { this.st.fillStyle = v; } get fillStyle() { return this.st.fillStyle; }
  set strokeStyle(v) { this.st.strokeStyle = v; } get strokeStyle() { return this.st.strokeStyle; }
  set lineWidth(v) { this.st.lineWidth = v; } get lineWidth() { return this.st.lineWidth; }
  set lineJoin(v) { this.st.lineJoin = v; } set lineCap(v) { this.st.lineCap = v; }
  set globalAlpha(v) { this.st.globalAlpha = v; } get globalAlpha() { return this.st.globalAlpha; }
  set font(v) { this.st.font = v; } get font() { return this.st.font; }
  set textAlign(v) { this.st.textAlign = v; } set textBaseline(v) { this.st.textBaseline = v; }
  set letterSpacing(v) { this.st.letterSpacing = v; }
  setLineDash(d) { this.st.dash = d; }
  beginPath() { this.path = []; }
  moveTo(x, y) { this.path.push(['M', ...this.pt(x, y)]); }
  lineTo(x, y) { this.path.push(['L', ...this.pt(x, y)]); }
  closePath() { this.path.push(['Z']); }
  rect(x, y, w, h) { this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath(); }
  arc(x, y, r, a0, a1) { const n = 48; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; this[i || this.path.length ? 'lineTo' : 'moveTo'](x + r * Math.cos(a), y + r * Math.sin(a)); } }
  d(path = this.path) { return path.map(([c, ...p]) => c + p.map(r2).join(' ')).join(''); }
  alpha() { return this.st.globalAlpha < 1 ? ` opacity="${r2(this.st.globalAlpha)}"` : ''; }
  fill() { this.out.push(`<path d="${this.d()}" fill="${this.st.fillStyle}"${this.alpha()}/>`); }
  stroke() {
    const u = this.unit, dash = this.st.dash.length ? ` stroke-dasharray="${this.st.dash.map(v => r2(v * u)).join(' ')}"` : '';
    this.out.push(`<path d="${this.d()}" fill="none" stroke="${this.st.strokeStyle}" stroke-width="${r2(this.st.lineWidth * u)}" stroke-linejoin="${this.st.lineJoin}" stroke-linecap="${this.st.lineCap}"${dash}${this.alpha()}/>`);
  }
  fillRect(x, y, w, h) { this.beginPath(); this.rect(x, y, w, h); this.fill(); }
  strokeRect(x, y, w, h) { this.beginPath(); this.rect(x, y, w, h); this.stroke(); }
  layout(s) {
    const { font, size } = fontFor(this.st.font), k = size / font.unitsPerEm, ls = parseFloat(this.st.letterSpacing) || 0;
    const glyphs = font.stringToGlyphs(s), xs = []; let x = 0;
    glyphs.forEach((g, i) => { if (i) x += font.getKerningValue(glyphs[i - 1], g) * k; xs.push(x); x += g.advanceWidth * k + ls; });
    return { font, size, k, glyphs, xs, width: x };
  }
  measureText(s) { return { width: this.layout(s).width }; }
  fillText(s, x, y) {
    const L = this.layout(s), { font, size, k } = L;
    const x0 = x - (this.st.textAlign === 'center' ? L.width / 2 : this.st.textAlign === 'right' ? L.width : 0);
    const asc = font.ascender * k, desc = font.descender * k;
    const base = this.st.textBaseline === 'middle' ? y + (asc + desc) / 2 : this.st.textBaseline === 'top' ? y + asc : y;
    const path = [];
    L.glyphs.forEach((g, i) => {
      for (const c of g.getPath(x0 + L.xs[i], base, size).commands) {
        if (c.type === 'Z') path.push(['Z']);
        else if (c.type === 'M' || c.type === 'L') path.push([c.type, ...this.pt(c.x, c.y)]);
        else if (c.type === 'Q') path.push(['Q', ...this.pt(c.x1, c.y1), ...this.pt(c.x, c.y)]);
        else if (c.type === 'C') path.push(['C', ...this.pt(c.x1, c.y1), ...this.pt(c.x2, c.y2), ...this.pt(c.x, c.y)]);
      }
    });
    this.out.push(`<path d="${this.d(path)}" fill="${this.st.fillStyle}"${this.alpha()}/>`);
  }
  svg(w, h, bg) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ''}${this.out.join('')}</svg>\n`;
  }
}
const draw = (w, h, fn, bg) => { const c = new SvgContext(); fn(c); return c.svg(w, h, bg); };
const png = (svg, width) => new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } }).render().asPng();

// Diagonal ground hatch shared by banners (the video draws the same texture).
function groundHatch(ctx, w, h) {
  ctx.save(); ctx.globalAlpha = .05; ctx.strokeStyle = C.ink; ctx.lineWidth = 2; ctx.beginPath();
  for (let d = -h; d < w; d += 26) { ctx.moveTo(d, h); ctx.lineTo(d + h, 0); }
  ctx.stroke(); ctx.restore();
}
function installBox(ctx, x, y, size) {
  const s = '$ ' + BR.copy.install, w = BR.measure(ctx, s, size, 'mono', 500) + size * 1.6, h = size * 2.4;
  BR.box(ctx, x, y, w, h, { fill: C.ink, shadow: size * .3, shadowColor: C.focus, lw: 0 });
  BR.txt(ctx, s, x + size * .8, y + h / 2, { size, font: 'mono', weight: 500, color: C.white });
  return w;
}

// ---------- assets ----------
function assets() {
  const A = {};
  const measureCtx = new SvgContext();
  // Mark: tight box with room for the hard shadow.
  A['mark.svg'] = draw(250, 212, c => BR.mark(c, 4, 4, 200));
  // Favicon: the small mark on a ground tile, legible at 16 px.
  const favicon = draw(100, 100, c => { BR.box(c, 3, 3, 94, 94, { fill: C.ground, shadow: 0, lw: 6, ch: 22 }); BR.mark(c, 12, 12, 76, 'small'); });
  A['favicon.svg'] = favicon;
  // Logo: horizontal lockup.
  const LS = 96, lw = Math.ceil(BR.lockupWidth(measureCtx, LS) + 24);
  A['logo.svg'] = draw(lw, 150, c => BR.lockup(c, 8, 75, LS));
  // README banner.
  A['banner.svg'] = draw(1280, 320, c => {
    groundHatch(c, 1280, 320);
    const w = BR.lockupWidth(c, 84); BR.lockup(c, (1280 - w) / 2, 128, 84);
    BR.txt(c, BR.copy.tagline.toUpperCase(), 640, 250, { size: 30, font: 'tech', weight: 700, align: 'center', ls: 3 });
  }, C.ground);
  // Social preview (GitHub/Open Graph 1280×640).
  const social = draw(1280, 640, c => {
    groundHatch(c, 1280, 640);
    BR.lockup(c, 90, 150, 92);
    BR.txt(c, BR.copy.tagline.toUpperCase(), 92, 285, { size: 34, font: 'tech', weight: 700, ls: 3 });
    let x = 92, y = 370; BR.copy.points.forEach((p, i) => { const t = p.title.toUpperCase(), sz = 24, w = BR.measure(c, t, sz) + sz * 1.2; if (x + w > 1190) { x = 92; y += 70; } BR.sticker(c, t, x + w / 2, y, { size: sz, bg: i === 3 ? C.ink : C.white, shadowColor: i === 3 ? C.focus : C.ink }); x += w + 22; });
    installBox(c, 92, 510, 30);
  }, C.ground);
  A['social-preview.svg'] = social;
  A['social-preview.png'] = png(social, 1280);
  for (const s of [16, 32, 48, 180, 512]) A[`favicon-${s}.png`] = png(favicon, s);
  A['favicon.ico'] = ico([16, 32, 48].map(s => A[`favicon-${s}.png`]), [16, 32, 48]);
  A['tokens.css'] = tokensCss('../fonts/');
  return A;
}
// ICO with embedded PNG images.
function ico(pngs, sizes) {
  const head = Buffer.alloc(6 + 16 * pngs.length); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach((p, i) => { const o = 6 + 16 * i, s = sizes[i] % 256; head.writeUInt8(s, o); head.writeUInt8(s, o + 1); head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6); head.writeUInt32LE(p.length, o + 8); head.writeUInt32LE(off, o + 12); off += p.length; });
  return Buffer.concat([head, ...pngs]);
}
function tokensCss(fontDir) {
  const faces = Object.values(BR.font).flatMap(f => f.file ? [[f.family, f.weight, f.file]] : Object.entries(f.weights).map(([w, file]) => [f.family, w, file]));
  return `/* Generated from brand/brand.js by brand/build.mjs. Do not edit. */\n` +
    faces.map(([fam, w, file]) => `@font-face { font-family: "${fam}"; font-weight: ${w}; font-display: swap; src: url("${fontDir}${file}") format("truetype"); }`).join('\n') +
    `\n:root {\n` +
    Object.entries(C).flatMap(([k, v]) => Array.isArray(v) ? v.map((x, i) => `  --ptb-agent-${i + 1}: ${x};`) : [`  --ptb-${k}: ${v};`]).join('\n') +
    `\n  --ptb-font-display: ${BR.font.display.stack};\n  --ptb-font-tech: ${BR.font.tech.stack};\n  --ptb-font-mono: ${BR.font.mono.stack};\n` +
    `  --ptb-outline: ${BR.form.outline}px;\n  --ptb-shadow: ${BR.form.shadow}px;\n}\n`;
}

// ---------- website ----------
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function siteHtml(A) {
  const cp = BR.copy, gh = 'https://' + cp.repo, logo = A['logo.svg'].replace('<svg ', '<svg role="img" aria-label="Pi Team Bright" ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${cp.name} — ${esc(cp.description)}</title>
<meta name="description" content="${esc(cp.tagline)} ${esc(cp.description)}">
<meta property="og:title" content="${cp.name}">
<meta property="og:description" content="${esc(cp.tagline)}">
<meta property="og:image" content="assets/social-preview.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">
<link rel="icon" href="assets/favicon.ico" sizes="48x48">
<link rel="apple-touch-icon" href="assets/favicon-180.png">
<link rel="stylesheet" href="assets/tokens.css">
<style>
  * { box-sizing: border-box; }
  html { color-scheme: light; }
  body { margin: 0; background: var(--ptb-ground); color: var(--ptb-ink); font: 500 18px/1.55 var(--ptb-font-tech);
    background-image: repeating-linear-gradient(-45deg, rgba(27,29,32,.04) 0 2px, transparent 2px 26px); }
  main { max-width: 1120px; margin: 0 auto; padding: 48px 24px 72px; }
  header svg { width: min(100%, 720px); height: auto; display: block; }
  h1 { font: 400 clamp(34px, 6vw, 64px)/1.05 var(--ptb-font-display); letter-spacing: -.01em; margin: 48px 0 16px; text-transform: uppercase; }
  .lede { font-size: 22px; max-width: 46ch; margin: 0 0 36px; }
  .install { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; background: var(--ptb-ink); color: var(--ptb-white);
    box-shadow: 10px 10px 0 var(--ptb-focus); padding: 18px 22px; max-width: 760px; font: 500 clamp(14px, 2.2vw, 20px) var(--ptb-font-mono); }
  .install code { flex: 1; overflow-x: auto; white-space: nowrap; }
  .install button { font: 700 14px var(--ptb-font-tech); letter-spacing: .08em; text-transform: uppercase; background: var(--ptb-white); color: var(--ptb-ink);
    border: 3px solid var(--ptb-white); padding: 6px 12px; cursor: pointer; }
  .install button:active { transform: translate(2px, 2px); }
  .points { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 28px; margin: 72px 0 0; padding: 0; list-style: none; }
  .points li { background: var(--ptb-white); border: var(--ptb-outline) solid var(--ptb-ink); box-shadow: var(--ptb-shadow) var(--ptb-shadow) 0 var(--ptb-ink); padding: 0 0 20px; position: relative; }
  .points li:last-child { background: var(--ptb-ink); color: var(--ptb-white); box-shadow: var(--ptb-shadow) var(--ptb-shadow) 0 var(--ptb-focus); }
  .points h2 { font: 400 22px/1.2 var(--ptb-font-display); text-transform: uppercase; margin: 0 0 12px; padding: 14px 20px; border-bottom: var(--ptb-outline) solid var(--ptb-ink); }
  .points li:nth-child(1) h2 { background: var(--ptb-agent-1); } .points li:nth-child(2) h2 { background: var(--ptb-agent-2); }
  .points li:nth-child(3) h2 { background: var(--ptb-agent-3); } .points li:nth-child(4) h2 { background: var(--ptb-focus); color: var(--ptb-white); border-color: var(--ptb-white); }
  .points p { margin: 0 20px 12px; }
  .points a { display: block; margin: 0 20px; color: inherit; font: 500 14px var(--ptb-font-mono); overflow-wrap: anywhere; }
  footer { margin-top: 80px; font: 700 15px var(--ptb-font-tech); letter-spacing: .12em; text-transform: uppercase; display: flex; gap: 24px; flex-wrap: wrap; }
  footer a { color: var(--ptb-ink); }
</style>
</head>
<body>
<main>
<header>${logo}</header>
<h1>${esc(cp.tagline)}</h1>
<p class="lede">${esc(cp.description)} A lead agent declares a Task graph; worker agents take ready work in their own panes and close it with evidence.</p>
<div class="install"><code id="cmd">$ ${esc(cp.install)}</code><button type="button" id="copy">Copy</button></div>
<ul class="points">
${cp.points.map(p => `<li><h2>${esc(p.title)}</h2><p>${esc(p.text)}</p><a href="${gh}/blob/main/${p.anchor}">${esc(p.anchor)} →</a></li>`).join('\n')}
</ul>
<footer><a href="${gh}">GitHub</a><a href="https://www.npmjs.com/package/@hypercarrier/pi-team-bright">npm</a><a href="${gh}/blob/main/LICENSE">${cp.license} license</a></footer>
</main>
<script>
document.getElementById('copy').addEventListener('click', e => {
  navigator.clipboard.writeText(${JSON.stringify(cp.install)}).then(() => { e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = 'Copy'; }, 1500); });
});
</script>
</body>
</html>
`;
}

// ---------- main ----------
const args = process.argv.slice(2), OUT = join(HERE, 'assets');
const A = assets();
if (args.includes('--check')) {
  // Vector and text outputs must match exactly. Raster outputs derive from those SVGs, and resvg
  // bytes can differ across platforms, so rasters only need to exist.
  const raster = f => /\.(png|ico)$/.test(f);
  const stale = Object.entries(A).filter(([f, v]) => !existsSync(join(OUT, f)) || (!raster(f) && !Buffer.from(v).equals(readFileSync(join(OUT, f)))));
  const extra = readdirSync(OUT).filter(f => !(f in A));
  for (const f of [...stale.map(([f]) => f), ...extra]) console.error('stale: brand/assets/' + f);
  if (stale.length || extra.length) { console.error('run: npm --prefix brand run build'); process.exit(1); }
  console.log(`brand/assets up to date (${Object.keys(A).length} files)`);
} else {
  mkdirSync(OUT, { recursive: true });
  for (const [f, v] of Object.entries(A)) writeFileSync(join(OUT, f), v);
  console.log(`wrote ${Object.keys(A).length} files to brand/assets`);
}
const si = args.indexOf('--site');
if (si >= 0) {
  const dir = resolve(args[si + 1] ?? '_site');
  mkdirSync(join(dir, 'assets'), { recursive: true }); mkdirSync(join(dir, 'fonts'), { recursive: true });
  for (const [f, v] of Object.entries(A)) writeFileSync(join(dir, 'assets', f), v);
  for (const f of readdirSync(join(HERE, 'fonts'))) copyFileSync(join(HERE, 'fonts', f), join(dir, 'fonts', f));
  writeFileSync(join(dir, 'index.html'), siteHtml(A));
  writeFileSync(join(dir, '.nojekyll'), '');
  console.log('wrote site to ' + dir);
}
