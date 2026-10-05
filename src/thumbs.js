'use strict';
// Previews for the results grid (full renders can be 16000px tall).
//  - normal screens: one 640px-wide preview, cropped to its top 400px if tall
//  - very tall pages (aspect >= 3.5): a 3-slice strip (top / middle / bottom) so the card conveys the whole page
const fs = require('node:fs');
const path = require('node:path');
const { nativeImage } = require('electron');

const THUMB_W = 640;
const THUMB_MAX_H = 400;
const STRIP_ASPECT = 3.5;
const STRIP_W = 428; // each slice is drawn ~214 css px wide on 2x screens
const STRIP_H = 800;

function writePng(outDir, rel, img) {
  fs.writeFileSync(path.join(outDir, rel), img.toPNG());
  return rel;
}

async function makeThumbs(result, send) {
  fs.mkdirSync(path.join(result.outDir, 'thumbs'), { recursive: true });
  const withPng = result.chunks.filter((c) => c.png);
  let done = 0;
  for (const c of withPng) {
    try {
      let img = nativeImage.createFromPath(path.join(result.outDir, c.png));
      if (!img.isEmpty()) {
        const { width, height } = img.getSize();
        const base = path.basename(c.png, '.png');
        if (height / width >= STRIP_ASPECT) {
          const rs = img.resize({ width: Math.min(STRIP_W, width), quality: 'good' });
          const { width: w, height: h } = rs.getSize();
          const sliceH = Math.min(STRIP_H, h);
          const ys = [0, Math.round((h - sliceH) / 2), h - sliceH];
          c.thumbs = ys.map((y, i) => writePng(result.outDir, path.join('thumbs', `${base}__${i + 1}.png`), rs.crop({ x: 0, y, width: w, height: sliceH })));
          c.thumb = c.thumbs[0];
        } else {
          img = img.resize({ width: Math.min(THUMB_W, width), quality: 'good' });
          const { width: w, height: h } = img.getSize();
          if (h > THUMB_MAX_H) img = img.crop({ x: 0, y: 0, width: w, height: THUMB_MAX_H });
          c.thumb = writePng(result.outDir, path.join('thumbs', `${base}.png`), img);
        }
      }
    } catch { /* fall back to the full image */ }
    done++;
    if (done % 4 === 0 || done === withPng.length) {
      send?.({ label: 'Preparing previews', done, total: withPng.length, pct: 96 + (done / withPng.length) * 4 });
      await new Promise((r) => setImmediate(r)); // let progress reach the UI
    }
  }
  // keep index.json in sync with the previews
  try {
    const f = path.join(result.outDir, 'index.json');
    const idx = JSON.parse(fs.readFileSync(f, 'utf8'));
    const byId = new Map(result.chunks.map((c) => [c.id, c]));
    for (const c of idx.chunks) { const m = byId.get(c.id); if (m?.thumb) { c.thumb = m.thumb; if (m.thumbs) c.thumbs = m.thumbs; } }
    fs.writeFileSync(f, JSON.stringify(idx, null, 2));
  } catch { /* index is a convenience */ }
}

module.exports = { makeThumbs };
