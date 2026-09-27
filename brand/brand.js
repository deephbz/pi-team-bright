// Pi Team Bright brand source: tokens, copy, and drawing primitives.
//
// This file is the single source for the brand. Every visual output derives from it:
//   build.mjs → SVG/PNG logo, favicon, banners, tokens.css, and the website
//   the promo video (marketing/) → Canvas2D frames
// The primitives draw through a Canvas2D context. build.mjs supplies an SVG context with the same
// API, so one drawing function yields both a video frame and a vector asset.
//
// Load it as a classic script (browser) or with `new Function(source)()` (Node); both set
// globalThis.PTBBrand.
(() => {
  const color = {
    ground: '#F2F3F1', concrete: '#E3E6E8', white: '#FFFFFF', ink: '#1B1D20', grey: '#8C9399',
    focus: '#E3262B', ok: '#62C14E',
    // One colour per worker agent, in order of appearance. Red is reserved for focus and the lead.
    agents: ['#2BB3D9', '#F5821F', '#F7C81E', '#1F5FD1'],
  };
  const font = {
    display: { family: 'Archivo Black', weight: 400, file: 'ArchivoBlack-Regular.ttf', stack: '"Archivo Black", Impact, sans-serif' },
    tech: { family: 'Chakra Petch', weights: { 500: 'ChakraPetch-Medium.ttf', 700: 'ChakraPetch-Bold.ttf' }, stack: '"Chakra Petch", sans-serif' },
    mono: { family: 'JetBrains Mono', weights: { 500: 'JetBrainsMono-Medium.ttf', 700: 'JetBrainsMono-Bold.ttf' }, stack: '"JetBrains Mono", ui-monospace, monospace' },
  };
  // Form: thick ink outlines, hard offset shadows, 45° chamfers. Values are at 1× (1080p frame).
  const form = { outline: 5, shadow: 10, chamfer: 26 };
  const tokens = { color, font, form };

  // Every claim links to the source that proves it (repo-relative).
  const copy = {
    name: 'Pi Team Bright',
    tagline: 'One lead. A visible team. Work you can prove.',
    description: 'Task-first Pi teams, visible in terminal panes.',
    install: 'pi install npm:@hypercarrier/pi-team-bright',
    repo: 'github.com/deephbz/pi-team-bright',
    license: 'MIT',
    points: [
      { title: 'Visible workers', text: 'Every worker agent runs in its own terminal pane beside the lead, laid out by tmux or Herdr.', anchor: 'src/utils/team-pane-layout.ts' },
      { title: 'Model roles', text: 'Define named roles in settings, each with its own model, thinking level, and use. The lead picks a role for every worker.', anchor: 'src/utils/model-role-settings.ts' },
      { title: 'DAG-native', text: 'The lead declares a Task graph. Dependencies, failure routes, and bounded retries are part of the contract.', anchor: 'src/task-authority/graph-control-schemas.ts' },
      { title: 'Robust task & message engine', text: 'Atomic Team snapshots, blocking waits that return on change, and Alerts to one recipient. Core protocols are model-checked in TLA+.', anchor: 'formal' },
    ],
  };

  const on = c => (c === color.agents[3] || c === color.focus || c === color.ink ? color.white : color.ink);

  // ---------- primitives (draw on any Canvas2D-compatible context) ----------
  function shape(ctx, x, y, w, h, ch = 0) {
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w - ch, y); ctx.lineTo(x + w, y + ch); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath();
  }
  function box(ctx, x, y, w, h, o = {}) {
    const sh = o.shadow ?? form.shadow, ch = o.ch ?? 0, lw = o.lw ?? form.outline;
    if (sh) { ctx.fillStyle = o.shadowColor ?? color.ink; shape(ctx, x + sh, y + sh, w, h, ch); ctx.fill(); }
    if (o.fill !== 'none') { shape(ctx, x, y, w, h, ch); ctx.fillStyle = o.fill ?? color.white; ctx.fill(); }
    if (lw) {
      ctx.save(); ctx.lineWidth = lw; ctx.strokeStyle = o.stroke ?? color.ink; ctx.lineJoin = 'miter';
      if (o.dash) ctx.setLineDash(o.dash);
      shape(ctx, x, y, w, h, ch); ctx.stroke(); ctx.restore();
    }
  }
  const fontStack = (kind = 'display') => font[kind].stack;
  function txt(ctx, s, x, y, o = {}) {
    ctx.save();
    ctx.font = `${o.weight ?? 400} ${o.size ?? 32}px ${fontStack(o.font)}`;
    ctx.fillStyle = o.color ?? color.ink; ctx.textAlign = o.align ?? 'left'; ctx.textBaseline = o.base ?? 'middle';
    ctx.globalAlpha *= o.alpha ?? 1;
    ctx.letterSpacing = (o.ls ?? 0) + 'px';
    ctx.fillText(s, x, y);
    ctx.restore();
  }
  function measure(ctx, s, size, kind = 'display', weight = 400, ls = 0) {
    ctx.save(); ctx.font = `${weight} ${size}px ${fontStack(kind)}`; ctx.letterSpacing = ls + 'px'; const w = ctx.measureText(s).width; ctx.restore(); return w;
  }
  function sticker(ctx, s, x, y, o = {}) {
    const size = o.size ?? 28, kind = o.font ?? 'display', weight = o.weight ?? 400, padX = size * .6, padY = size * .45;
    const w = measure(ctx, s, size, kind, weight, o.ls) + padX * 2, h = size + padY * 2, bg = o.bg ?? color.white;
    ctx.save(); ctx.translate(x, y); ctx.rotate(o.rot ?? 0); if (o.scale) ctx.scale(o.scale, o.scale); ctx.globalAlpha *= o.alpha ?? 1;
    box(ctx, -w / 2, -h / 2, w, h, { fill: bg, shadow: o.shadow ?? 6, lw: o.lw ?? 4, shadowColor: o.shadowColor });
    txt(ctx, s, 0, 2, { size, font: kind, weight, align: 'center', color: o.fg ?? on(bg), ls: o.ls });
    ctx.restore();
    return w;
  }

  // ---------- the mark ----------
  // A red lead wired to its worker agents. The last worker is an open slot: a team of n, not of three.
  // 'full' fills a 120×100 unit box; 'small' (favicon sizes) drops the open slot and thickens lines.
  const MARK_BOX = { full: [120, 100], small: [100, 100] };
  function mark(ctx, x, y, h, variant = 'full') {
    const u = h / 100;
    ctx.save(); ctx.translate(x, y); ctx.scale(u, u);
    ctx.strokeStyle = color.ink; ctx.lineJoin = 'miter'; ctx.lineCap = 'butt';
    if (variant === 'small') {
      ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(56, 50); ctx.lineTo(70, 50); ctx.moveTo(70, 21); ctx.lineTo(70, 79); ctx.moveTo(66, 25); ctx.lineTo(80, 25); ctx.moveTo(66, 75); ctx.lineTo(80, 75); ctx.stroke();
      box(ctx, 4, 22, 52, 56, { fill: color.focus, shadow: 0, lw: 8, ch: 16 });
      box(ctx, 74, 11, 24, 28, { fill: color.agents[0], shadow: 0, lw: 7 });
      box(ctx, 74, 61, 24, 28, { fill: color.agents[1], shadow: 0, lw: 7 });
    } else {
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(52, 50); ctx.lineTo(72, 50); ctx.moveTo(72, 15); ctx.lineTo(72, 85);
      for (const wy of [18, 50, 82]) { ctx.moveTo(69, wy); ctx.lineTo(86, wy); }
      ctx.stroke();
      box(ctx, 4, 26, 48, 48, { fill: color.focus, shadow: 5, lw: 5, ch: 12 });
      box(ctx, 86, 7, 24, 22, { fill: color.agents[0], shadow: 3, lw: 4 });
      box(ctx, 86, 39, 24, 22, { fill: color.agents[1], shadow: 3, lw: 4 });
      box(ctx, 86, 71, 24, 22, { fill: 'none', shadow: 0, lw: 4, dash: [6, 4] });
    }
    ctx.restore();
    return MARK_BOX[variant][0] * u;
  }

  // ---------- wordmark and lockup ----------
  // "PI TEAM" in ink; "BRIGHT" reversed out of a red slab with a hard ink shadow.
  function wordmark(ctx, x, y, size) {
    const ls = -size * .02, a = measure(ctx, 'PI TEAM ', size, 'display', 400, ls), b = measure(ctx, 'BRIGHT', size, 'display', 400, ls);
    const pad = size * .16, sh = size * .07;
    txt(ctx, 'PI TEAM', x, y, { size, ls });
    box(ctx, x + a - pad * .6, y - size * .62, b + pad * 1.6, size * 1.2, { fill: color.focus, shadow: sh, lw: Math.max(2, size * .045) });
    txt(ctx, 'BRIGHT', x + a + pad * .2, y, { size, ls, color: color.white });
    return a + b + pad;
  }
  // Horizontal lockup: mark then wordmark, vertically centred on y.
  function lockup(ctx, x, y, size) {
    const mh = size * 1.45, mw = mark(ctx, x, y - mh / 2, mh);
    return mw + size * .45 + wordmark(ctx, x + mw + size * .45, y, size);
  }
  const lockupWidth = (ctx, size) => MARK_BOX.full[0] * size * 1.45 / 100 + size * .45 + measure(ctx, 'PI TEAM ', size, 'display', 400, -size * .02) + measure(ctx, 'BRIGHT', size, 'display', 400, -size * .02) + size * .16;

  globalThis.PTBBrand = { tokens, color, font, form, copy, on, shape, box, txt, measure, sticker, mark, MARK_BOX, wordmark, lockup, lockupWidth };
})();
