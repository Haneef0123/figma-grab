'use strict';
// Renders the app icon (1024px PNG) with signed-distance shapes + 3x3 supersampling. No dependencies.
const zlib = require('node:zlib');
const fs = require('node:fs');
const N = 1024, SS = 3;
const sdRoundRect = (x, y, cx, cy, hw, hh, r) => { const qx = Math.abs(x - cx) - (hw - r), qy = Math.abs(y - cy) - (hh - r); return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; };
const sdSeg = (x, y, ax, ay, bx, by) => { const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay; const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay))); return Math.hypot(pax - bax * h, pay - bay * h); };
const lerp = (a, b, t) => a + (b - a) * t;
// viewfinder corners
const L = 300, R = 724, ARM = 120, T = 26; // T = half stroke width
const corners = [[L, L, 1, 1], [R, L, -1, 1], [L, R, 1, -1], [R, R, -1, -1]];
const px = Buffer.alloc(N * N * 4);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  let r = 0, g = 0, b = 0, a = 0;
  for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
    const x = i + (sx + .5) / SS, y = j + (sy + .5) / SS;
    const d = sdRoundRect(x, y, 512, 512, 412, 412, 186);
    if (d > 0) continue;
    const t = (y - 100) / 824;
    let cr = lerp(118, 62, t), cg = lerp(134, 80, t), cb = lerp(246, 198, t); // soft indigo gradient
    let w = 0;
    for (const [cx, cy, dx, dy] of corners) {
      w = Math.max(w, 1 - Math.min(1, Math.max(0, (Math.min(sdSeg(x, y, cx, cy, cx + dx * ARM, cy), sdSeg(x, y, cx, cy, cx, cy + dy * ARM)) - T) / 1.2)));
    }
    w = Math.max(w, 1 - Math.min(1, Math.max(0, (Math.hypot(x - 512, y - 512) - 40) / 1.2)));
    cr = lerp(cr, 255, w); cg = lerp(cg, 255, w); cb = lerp(cb, 255, w);
    r += cr; g += cg; b += cb; a += 1;
  }
  const o = (j * N + i) * 4, n = SS * SS;
  if (a) { px[o] = r / a; px[o + 1] = g / a; px[o + 2] = b / a; px[o + 3] = Math.round(255 * a / n); }
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync(__dirname + '/icon.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote build/icon.png');
