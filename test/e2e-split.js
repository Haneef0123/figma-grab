'use strict';
// Offline end-to-end test of long-page splitting, replaying real "Stock Detail Page SEO" frame data
// (a 1366x6200 desktop page and a 360x8373 mobile page). Run: node test/e2e-split.js
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { grab } = require('../src/core');

const FIX = path.join(__dirname, 'fixtures', 'stock-detail');
const KEY = 'SPLITKEY123456789012345';
const ROOT = '7907:40925';
const wrappers = { desktop: JSON.parse(fs.readFileSync(path.join(FIX, 'desktop.json'))), mobile: JSON.parse(fs.readFileSync(path.join(FIX, 'mobile.json'))) };
const frames = Object.values(wrappers).map((w) => w.document);
const rootDoc = { id: ROOT, name: 'SEO Changes_Jun 17', type: 'SECTION', absoluteBoundingBox: { x: 0, y: 0, width: 2000, height: 9000 }, children: frames.map((f) => ({ id: f.id, name: f.name, type: f.type })) };
const docsById = Object.fromEntries(frames.map((f, i) => [f.id, Object.values(wrappers)[i]]));
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const base = `http://127.0.0.1:${server.address().port}`;
  if (u.pathname === '/img.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
  if (u.pathname === `/v1/files/${KEY}/nodes`) {
    const nodes = {};
    for (const id of u.searchParams.get('ids').split(',')) nodes[id] = id === ROOT ? { document: rootDoc } : docsById[id] || null;
    return send({ name: 'Stock Detail Page SEO', nodes });
  }
  if (u.pathname === `/v1/images/${KEY}`) return send({ images: Object.fromEntries(u.searchParams.get('ids').split(',').map((id) => [id, `${base}/img.png`])) });
  if (u.pathname === `/v1/files/${KEY}/images`) return send({ meta: { images: {} } });
  if (u.pathname === `/v1/files/${KEY}/styles`) return send({ meta: {} });
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.FIGMA_API_BASE = `http://127.0.0.1:${server.address().port}`;
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-grab-split-'));
  const url = `https://www.figma.com/design/${KEY}/Stock-Detail-Page-SEO?node-id=7907-40925`;
  let passed = 0;
  const ok = (m) => { passed++; console.log('  ✓', m); };

  const off = await grab({ url, token: 't', outRoot, fetch: globalThis.fetch, split: false });
  assert.equal(off.chunks.length, 2);
  ok('split off -> exactly the 2 frames');

  const r = await grab({ url, token: 't', outRoot, fetch: globalThis.fetch });
  const parents = r.chunks.filter((c) => c.split);
  const kids = r.chunks.filter((c) => c.parentId);
  assert.equal(parents.length, 2);
  assert.equal(kids.length, r.chunks.length - 2);
  assert.ok(kids.length >= 40, `expected ~45 sections, got ${kids.length}`);
  ok(`split on -> 2 pages + ${kids.length} sections`);

  for (const p of parents) {
    assert.equal(p.title, 'Full page');
    assert.ok(p.group.at(-1) === p.name, 'parent group ends with its own name');
    const myKids = kids.filter((k) => k.parentId === p.id);
    assert.ok(myKids.every((k) => k.group.join('>') === p.group.join('>')), 'sections share the parent group');
    // reading order: the parent sits right before its sections
    const i = r.chunks.indexOf(p);
    assert.ok(r.chunks.slice(i + 1, i + 1 + myKids.length).every((k) => k.parentId === p.id));
  }
  ok('parents are "Full page" cards, followed by their sections in order, sharing one group');

  const desktop = r.chunks.find((c) => c.name === 'Desktop-Default');
  assert.equal(desktop.height, 6200, 'real content height, not the 800px frame box');
  ok('desktop height is the real 6200 px (frame box says 800)');

  const titles = kids.map((k) => k.title);
  for (const t of ['Shareholder Returns · Share Price History', 'Market Depth', 'Indicators · Pivot Levels', 'Moving Averages · Volume Trend', 'Mutual Funds Invested · Events']) {
    assert.ok(titles.includes(t), `missing title: ${t}`);
  }
  assert.ok(!kids.some((k) => /^container$/i.test(k.title)), 'no generic "Container" titles');
  ok('generic "Container" layers are titled from their heading text');

  for (const k of kids) {
    for (const f of [k.json, k.jsonSlim, k.png]) assert.ok(fs.existsSync(path.join(r.outDir, f)), f);
    const doc = JSON.parse(fs.readFileSync(path.join(r.outDir, k.json), 'utf8')).document;
    assert.equal(doc.id, k.id, 'section JSON holds that section');
  }
  ok('every section has its own JSON (full + slim) and render, containing the right subtree');

  assert.ok(kids.every((k) => k.url.includes(`node-id=${k.id.replace(':', '-')}`)));
  ok('every section has its own Figma deep link');

  const idx = JSON.parse(fs.readFileSync(path.join(r.outDir, 'index.json'), 'utf8'));
  assert.equal(idx.chunks.length, r.chunks.length);
  ok('index.json lists everything');

  console.log(`\n${passed} checks passed.`);
  server.close();
  fs.rmSync(outRoot, { recursive: true, force: true });
})().catch((e) => { console.error('\nFAILED:', e); server.close(); process.exit(1); });
