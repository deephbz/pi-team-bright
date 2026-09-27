// render.mjs: drive studio.html in headless Chrome.
//   node render.mjs --stills=1,8,20 --out=out/stills     JPEG stills for visual checks
//   node render.mjs --frames --workers=4 [--resume]       all frames → out/frames; --resume skips existing files
//   node render.mjs --encode --out=out/ptb-promo.mp4      frames + assets/soundtrack.wav → MP4
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync, renameSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
new Function(readFileSync('timeline.js', 'utf8'))();
const { DUR, FPS } = globalThis.TL;
const CHROME = args.chrome || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FRAMES = 'out/frames';
const run = (cmd, a) => new Promise((ok, bad) => { const p = spawn(cmd, a, { stdio: 'inherit' }); p.on('close', c => c ? bad(new Error(cmd + ' exited ' + c)) : ok()); });

if (args.encode) {
  const out = args.out || 'out/ptb-promo.mp4';
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-stats', '-framerate', String(FPS), '-i', `${FRAMES}/f%05d.jpg`, '-i', 'assets/soundtrack.wav', '-frames:v', String(Math.round(DUR * FPS)),
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', '-shortest', out]);
  console.log('wrote ' + out);
  process.exit(0);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 0, args: ['--allow-file-access-from-files', '--window-size=1920,1080'] });
async function openPage(tag = '') {
  const page = await browser.newPage();
  page.on('console', m => { if (['error', 'warn'].includes(m.type())) console.log(`[page${tag}]`, m.text()); });
  page.on('pageerror', e => console.log(`[page error${tag}]`, e.message));
  await page.goto(pathToFileURL(resolve('studio.html')).href + '?render', { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.ready === true', { timeout: 60000 });
  return page;
}
const frameOf = async (page, t, q = .93) => {
  const url = await page.evaluate((t, q) => window.renderAt(t, 'image/jpeg', q), t, q);
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
};

if (args.stills) {
  const page = await openPage(), out = args.out || 'out/stills'; mkdirSync(out, { recursive: true });
  for (const s of String(args.stills).split(',').map(Number)) {
    const f = `${out}/t${s.toFixed(2).replace('.', '_')}.jpg`; writeFileSync(f, await frameOf(page, s)); console.log(f);
  }
} else if (args.frames) {
  mkdirSync(FRAMES, { recursive: true });
  const n = Math.round(DUR * FPS), workers = +(args.workers || 4), todo = [];
  for (let i = 0; i < n; i++) { const f = `${FRAMES}/f${String(i).padStart(5, '0')}.jpg`; if (!args.resume || !existsSync(f) || statSync(f).size < 1000) todo.push(i); }
  console.log(`${todo.length}/${n} frames to render, ${workers} workers`);
  let next = 0, done = 0; const start = Date.now();
  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    const page = await openPage('#' + w);
    while (next < todo.length) {
      const i = todo[next++], f = `${FRAMES}/f${String(i).padStart(5, '0')}.jpg`;
      writeFileSync(f + '.tmp', await frameOf(page, i / FPS)); renameSync(f + '.tmp', f);
      if (++done % 150 === 0 || done === todo.length) console.log(`frame ${done}/${todo.length}  ${((Date.now() - start) / done).toFixed(0)} ms/frame effective`);
    }
  }));
}
await browser.close();
