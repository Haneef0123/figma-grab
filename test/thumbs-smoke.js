'use strict';
// Run with: npx electron test/thumbs-smoke.js  -- exercises thumbs.js on a previous extraction folder.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeThumbs } = require('../src/thumbs');

app.whenReady().then(async () => {
  const src = path.join(os.homedir(), 'stock-comparison');
  const index = JSON.parse(fs.readFileSync(path.join(src, 'index.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-'));
  fs.cpSync(path.join(src, 'renders'), path.join(tmp, 'renders'), { recursive: true });
  const result = { outDir: tmp, chunks: index.map((c) => ({ ...c })) };
  const steps = [];
  const t0 = Date.now();
  await makeThumbs(result, (p) => steps.push(Math.round(p.pct)));
  const made = result.chunks.filter((c) => c.thumb);
  const sizes = made.map((c) => fs.statSync(path.join(tmp, c.thumb)).size);
  const full = result.chunks.filter((c) => c.png).reduce((n, c) => n + fs.statSync(path.join(tmp, c.png)).size, 0);
  const { nativeImage } = require('electron');
  const dims = made.map((c) => nativeImage.createFromPath(path.join(tmp, c.thumb)).getSize());
  console.log('THUMBS', JSON.stringify({
    withPng: result.chunks.filter((c) => c.png).length, made: made.length, ms: Date.now() - t0,
    fullMB: +(full / 1048576).toFixed(1), thumbMB: +(sizes.reduce((a, b) => a + b, 0) / 1048576).toFixed(2),
    maxW: Math.max(...dims.map((d) => d.width)), maxH: Math.max(...dims.map((d) => d.height)), progressEnd: steps.at(-1),
  }));
  fs.rmSync(tmp, { recursive: true, force: true });
  app.quit();
});
