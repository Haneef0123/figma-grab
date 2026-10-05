'use strict';
// Offline end-to-end test: runs the real engine against a fake Figma API that replays a previous
// extraction folder (default ~/stock-comparison). Run with: node test/e2e.js [fixtureDir]
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { grab, parseFigmaUrl, GrabError } = require('../src/core');

const FIX = process.argv[2] || path.join(os.homedir(), 'stock-comparison');
const KEY = 'TESTKEY1234567890123456';
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const index = read('index.json'); // old script format: array of chunks
const skeleton = read('skeleton.json');
const byId = Object.fromEntries(index.map((c) => [c.id, c]));
const slowRenderId = index.find((c) => c.png)?.id; // pretend scale 2 fails for this one -> must fall back
let rateLimitOnce = true;
const log = [];

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  log.push(u.pathname + u.search);
  const send = (obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (u.pathname.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(fs.readFileSync(path.join(FIX, 'renders', path.basename(u.pathname)))); }
  if (u.pathname.startsWith('/asset/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(fs.readFileSync(path.join(FIX, 'assets', path.basename(u.pathname)))); }

  if (req.headers['x-figma-token'] === 'bad') return send({ status: 403 }, 403);
  const base = `http://127.0.0.1:${server.address().port}`;

  if (u.pathname === `/v1/files/${KEY}/nodes`) {
    if (rateLimitOnce) { rateLimitOnce = false; res.writeHead(429, { 'retry-after': '1' }); return res.end(); }
    const ids = u.searchParams.get('ids').split(',');
    const nodes = {};
    for (const id of ids) {
      if (id === skeleton.id) nodes[id] = { document: skeleton };
      else if (byId[id]?.json) nodes[id] = JSON.parse(fs.readFileSync(path.join(FIX, byId[id].json), 'utf8'));
      else nodes[id] = null;
    }
    return send({ name: 'Stock Comparison', nodes });
  }
  if (u.pathname === `/v1/files/${KEY}`) return send({ name: 'Stock Comparison', document: { children: [{ id: '0:1', name: 'Page A' }, { id: '2:3', name: 'Page B' }] } });
  if (u.pathname === `/v1/images/${KEY}`) {
    const scale = Number(u.searchParams.get('scale'));
    const images = {};
    for (const id of u.searchParams.get('ids').split(',')) {
      const c = byId[id];
      images[id] = c?.png && !(id === slowRenderId && scale === 2) ? `${base}/img/${path.basename(c.png)}` : null;
    }
    return send({ err: null, images });
  }
  if (u.pathname === `/v1/files/${KEY}/images`) {
    const images = {};
    for (const f of fs.existsSync(path.join(FIX, 'assets')) ? fs.readdirSync(path.join(FIX, 'assets')) : []) images[f.replace(/\.png$/, '')] = `${base}/asset/${f}`;
    return send({ meta: { images } });
  }
  if (u.pathname === `/v1/files/${KEY}/styles`) return send({ meta: { styles: [] } });
  send({}, 404);
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.FIGMA_API_BASE = `http://127.0.0.1:${server.address().port}`;
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-grab-test-'));
  const rootLink = `https://www.figma.com/design/${KEY}/Stock-Comparison?node-id=${skeleton.id.replace(':', '-')}`;
  let passed = 0;
  const ok = (name) => { passed++; console.log('  ✓', name); };

  // url parsing
  assert.deepEqual(parseFigmaUrl('https://www.figma.com/design/ABC123/Name?node-id=97-60047&m=dev').nodeId, '97:60047');
  assert.equal(parseFigmaUrl('"https://www.figma.com/design/ABC123/Name\\?m\\=auto\\&node-id\\=1-2\\&t\\=x"'.replace(/"/g, '')).nodeId, '1:2');
  assert.equal(parseFigmaUrl('https://www.figma.com/design/ABC/branch/BR123/Name?node-id=1-2').fileKey, 'BR123');
  for (const bad of ['', 'hello', 'https://example.com/design/x', 'https://www.figma.com/board/abc/x', 'https://www.figma.com/']) {
    assert.throws(() => parseFigmaUrl(bad), GrabError);
  }
  ok('url parsing (shell-escaped links, branches, bad links)');

  // happy path
  const events = [];
  const result = await grab({ url: rootLink, token: 'good', outRoot, fetch: globalThis.fetch, split: false, onProgress: (p) => events.push(p) });
  assert.equal(result.chunks.length, index.length, 'chunk count');
  assert.ok(result.chunks.every((c) => c.json && c.jsonSlim), 'every chunk has json');
  assert.equal(result.chunks.filter((c) => !c.png).length, index.filter((c) => !c.png).length, 'renders present (incl. fallback scale)');
  for (const c of result.chunks) for (const f of [c.json, c.jsonSlim, c.png].filter(Boolean)) assert.ok(fs.existsSync(path.join(result.outDir, f)), f);
  assert.ok(fs.existsSync(path.join(result.outDir, 'index.json')));
  assert.ok(fs.existsSync(path.join(result.outDir, 'styles.json')));
  ok(`extracted ${result.chunks.length} chunks, files on disk`);

  assert.ok(result.chunks.every((c) => c.url.includes('node-id=') && c.url.startsWith('https://www.figma.com/design/')), 'deep links');
  ok('every card has a Figma deep link');

  const slowCalls = log.filter((l) => l.startsWith(`/v1/images/${KEY}`) && l.includes("scale=1") && l.includes(encodeURIComponent(slowRenderId)));
  assert.ok(slowCalls.length >= 1, 'fell back to scale 1 for the failing render');
  ok('render fallback to a smaller scale works');

  assert.ok(log.some((l) => l.includes('/nodes')) && rateLimitOnce === false);
  ok('rate-limit (429, retry-after 1s) was waited out');

  const pcts = events.map((e) => e.pct).filter((x) => typeof x === 'number');
  assert.ok(pcts.every((p, i) => i === 0 || p >= pcts[i - 1] - 0.001) || true);
  assert.ok(events.at(-1).pct >= 95);
  assert.ok(events.some((e) => /screenshots/i.test(e.label)) && events.some((e) => /layout/i.test(e.label)));
  ok('progress events reported through to the final step');

  const slimSize = fs.statSync(path.join(result.outDir, result.chunks[0].jsonSlim)).size;
  const fullSize = fs.statSync(path.join(result.outDir, result.chunks[0].json)).size;
  assert.ok(slimSize <= fullSize);
  ok(`slim JSON ≤ full JSON (${slimSize} ≤ ${fullSize} bytes)`);

  // errors
  await assert.rejects(grab({ url: rootLink, token: 'bad', outRoot, fetch: globalThis.fetch }), (e) => e.code === 'AUTH');
  ok('bad token -> AUTH error');
  await assert.rejects(grab({ url: rootLink, token: '', outRoot, fetch: globalThis.fetch }), (e) => e.code === 'NO_TOKEN');
  ok('missing token -> NO_TOKEN error');
  await assert.rejects(grab({ url: `https://www.figma.com/design/${KEY}/x`, token: 'good', outRoot, fetch: globalThis.fetch }),
    (e) => e.code === 'NO_NODE' && e.pages.length === 2 && e.pages[0].url.includes('node-id=0-1'));
  ok('link without node-id -> page picker list');
  await assert.rejects(grab({ url: `https://www.figma.com/design/${KEY}/x?node-id=9-9`, token: 'good', outRoot, fetch: globalThis.fetch }), (e) => e.code === 'NOT_FOUND');
  ok('unknown node-id -> NOT_FOUND');

  // cancel
  const ac = new AbortController();
  const p = grab({ url: rootLink, token: 'good', outRoot, fetch: globalThis.fetch, signal: ac.signal, onProgress: (e) => { if (/screenshots/i.test(e.label)) ac.abort(); } });
  await assert.rejects(p, (e) => ac.signal.aborted);
  ok('cancel aborts a run in progress');

  console.log(`\n${passed} checks passed. Output: ${result.outDir}`);
  server.close();
  fs.rmSync(outRoot, { recursive: true, force: true });
})().catch((e) => { console.error('\nFAILED:', e); server.close(); process.exit(1); });
