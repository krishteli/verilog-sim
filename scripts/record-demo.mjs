// Records docs/demo.gif: a scripted tour of the app.
//
//   npm run dev                         # in one terminal
//   node scripts/record-demo.mjs        # in another (or pass a URL)
//   ... --frames <dir>                  # also save every 8th kept frame as PNG, to review it
//
// How: Playwright drives a real browser (the Microsoft Edge already installed
// on Windows, so nothing extra to download) through the app while a loop
// screenshots it ~10 times a second. Each frame keeps its real duration, and
// identical consecutive frames are merged, which keeps the GIF small. gifenc
// (pure JS) quantises each frame to 256 colours and writes the GIF.
//
// Scripted rather than screen-recorded, so it's reproducible: re-run it
// whenever the UI changes and the README stays current.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const args = process.argv.slice(2);
const framesFlag = args.indexOf('--frames');
const framesDir = framesFlag >= 0 ? args.splice(framesFlag, 2)[1] : null;
const url = args[0] ?? 'http://localhost:5173/';
const out = new URL('../docs/demo.gif', import.meta.url);
const W = 1000;
const H = 600;
const FRAME_MS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: W, height: H }, colorScheme: 'dark', deviceScaleFactor: 1 });

// Start from a clean slate, and draw a visible cursor (headless screenshots don't include one).
await page.addInitScript(() => {
  localStorage.clear();
  addEventListener('DOMContentLoaded', () => {
    const dot = document.createElement('div');
    dot.style.cssText =
      'position:fixed;z-index:99999;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;' +
      'background:rgba(255,255,255,.35);border:2px solid #fff;pointer-events:none;left:-50px;top:-50px;transition:transform .08s';
    document.body.append(dot);
    addEventListener('mousemove', (e) => ((dot.style.left = e.clientX + 'px'), (dot.style.top = e.clientY + 'px')), true);
    addEventListener('mousedown', () => (dot.style.transform = 'scale(.6)'), true);
    addEventListener('mouseup', () => (dot.style.transform = ''), true);
  });
});
await page.goto(url);
await page.waitForSelector('.monaco-editor');
await page.waitForSelector('.wave-canvas');

// ---- recorder -------------------------------------------------------------------
const frames = [];
let recording = true;
const recorder = (async () => {
  while (recording) {
    const t = Date.now();
    frames.push({ png: await page.screenshot({ type: 'png' }), t });
    await sleep(Math.max(0, FRAME_MS - (Date.now() - t)));
  }
})();

// ---- the tour ---------------------------------------------------------------------
async function moveTo(locator, steps = 18) {
  const b = await locator.boundingBox();
  if (!b) throw new Error(`not visible: ${locator}`);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps });
}
async function click(locator, pause = 400) {
  await moveTo(locator);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(pause);
}
async function hold(locator, ms) {
  await moveTo(locator);
  await page.mouse.down();
  await sleep(ms);
  await page.mouse.up();
}

// 1. Waveform of the counter example: place the cursor, hover along the trace.
await page.mouse.move(W / 2, H / 2);
await sleep(1200);
const canvas = page.locator('.wave-canvas');
const cb = await canvas.boundingBox();
await page.mouse.move(cb.x + cb.width * 0.3, cb.y + 40, { steps: 15 });
await page.mouse.down();
await page.mouse.up();
await page.mouse.move(cb.x + cb.width * 0.7, cb.y + 40, { steps: 25 });
await page.mouse.down();
await page.mouse.up();
await sleep(1200);

// 2. Schematic: the testbench, then into the counter.
await click(page.getByRole('tab', { name: 'Schematic' }), 1800);
await click(page.locator('.sch-node.instance').first(), 2200);

// 3. Basys 3 board: load the demo, flip switches, reset, pause.
await page.selectOption('select[aria-label="Load an example"]', 'basys3');
await click(page.getByRole('tab', { name: 'Basys 3 board' }), 1800);
for (const i of [15, 9, 4, 0]) await click(page.getByRole('switch', { name: `SW${i}`, exact: true }), 250);
await sleep(1500);
await hold(page.getByRole('button', { name: 'btnC', exact: true }), 600);
await sleep(2200);
await hold(page.getByRole('button', { name: 'btnU', exact: true }), 1800);
await sleep(1500);

recording = false;
await recorder;
await browser.close();

// ---- encode -----------------------------------------------------------------------
const gif = GIFEncoder();
let kept = 0;
for (let i = 0; i < frames.length; i++) {
  const f = frames[i];
  const next = frames[i + 1]?.t ?? f.t + 1500;
  // Merge runs of identical frames into one longer frame.
  if (i > 0 && f.png.equals(frames[i - 1].png)) continue;
  let end = next;
  for (let j = i + 1; j < frames.length && frames[j].png.equals(f.png); j++) end = frames[j + 1]?.t ?? frames[j].t + 1500;
  const { data, width, height } = PNG.sync.read(f.png);
  const palette = quantize(data, 256);
  gif.writeFrame(applyPalette(data, palette), width, height, { palette, delay: end - f.t });
  if (framesDir && kept % 8 === 0) {
    mkdirSync(framesDir, { recursive: true });
    writeFileSync(join(framesDir, `frame-${String(kept).padStart(3, '0')}.png`), f.png);
  }
  kept++;
}
gif.finish();
writeFileSync(out, gif.bytes());
console.log(`${frames.length} frames captured, ${kept} kept, ${(gif.bytes().length / 1e6).toFixed(1)} MB -> ${out.pathname}`);
