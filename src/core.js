'use strict';
// Figma extraction engine. Pure Node (no Electron imports) so it can be tested headlessly.
// Given a Figma link it finds every screen (frame) under the linked page/section, then saves
// each one's full JSON + a PNG render, plus the image fills they use.

const fs = require('node:fs/promises');
const path = require('node:path');
const { extentOf, splitSections, titleFor } = require('./split');

const MAX_DEPTH = 4; // how many nested Sections we descend through
const JSON_BATCH = 8;
const RENDER_BATCH = 4;
const DOWNLOAD_CONCURRENCY = 6;
const MAX_RATE_WAIT_S = 120;
const CONTAINERS = new Set(['CANVAS', 'SECTION']);
const NOT_A_SCREEN = new Set(['VECTOR', 'LINE', 'ELLIPSE', 'STAR', 'POLYGON', 'BOOLEAN_OPERATION']);
const STRIP_FOR_SLIM = ['vectorNetwork', 'vectorPaths', 'fillGeometry', 'strokeGeometry'];

class GrabError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'GrabError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const apiBase = () => process.env.FIGMA_API_BASE || 'https://api.figma.com';
const enc = encodeURIComponent;
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
  });
const slug = (s) => String(s).replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'untitled';
const chunkArray = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function pngSize(file) {
  const fh = await fs.open(file, 'r');
  try {
    const b = Buffer.alloc(24);
    await fh.read(b, 0, 24, 0);
    return b.toString('ascii', 1, 4) === 'PNG' ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
  } finally { await fh.close(); }
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    })
  );
}

// ---------- link parsing ----------

function parseFigmaUrl(raw) {
  const cleaned = String(raw || '').trim().replace(/\\/g, ''); // shell-escaped links keep stray backslashes
  let u;
  try { u = new URL(cleaned); } catch { u = null; }
  if (!u || !/(^|\.)figma\.com$/.test(u.hostname)) {
    throw new GrabError('BAD_URL', 'That doesn’t look like a Figma link. Copy one from Figma, e.g. https://www.figma.com/design/…');
  }
  const parts = u.pathname.split('/').filter(Boolean);
  const kind = parts[0];
  if (['board', 'slides', 'make'].includes(kind)) {
    throw new GrabError('UNSUPPORTED', 'FigJam, Slides and Make links aren’t supported. Use a link to a Figma Design file.');
  }
  if (!['design', 'file', 'proto'].includes(kind)) {
    throw new GrabError('BAD_URL', 'That doesn’t look like a link to a Figma Design file.');
  }
  const fileKey = parts[2] === 'branch' ? parts[3] : parts[1];
  if (!fileKey) throw new GrabError('BAD_URL', 'That Figma link is missing the file ID.');
  let nodeId = u.searchParams.get('node-id');
  if (nodeId && !nodeId.includes(':')) nodeId = nodeId.replace('-', ':');
  return { fileKey, nodeId: nodeId || null, origin: u.origin, pathname: u.pathname };
}

const nodeLink = (link, id) => `${link.origin}${link.pathname}?node-id=${id.replace(':', '-')}`;

// ---------- Figma API ----------

async function api(ctx, p) {
  for (let attempt = 0; ; attempt++) {
    ctx.signal?.throwIfAborted();
    let res;
    try {
      res = await ctx.fetch(apiBase() + p, { headers: { 'X-Figma-Token': ctx.token }, signal: ctx.signal });
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      if (attempt >= 2) throw new GrabError('NETWORK', 'Couldn’t reach Figma. Check your connection and try again.');
      await sleep(1500 * (attempt + 1), ctx.signal);
      continue;
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 10);
      if (wait > MAX_RATE_WAIT_S || attempt >= 5) {
        const h = Math.max(1, Math.round(wait / 3600));
        throw new GrabError('RATE_LIMIT', `Figma is limiting this account’s API use right now (try again in about ${wait > 3600 ? h + ' h' : Math.ceil(wait / 60) + ' min'}). Seats with limited access get a very small quota; a Full or Dev seat token avoids this.`);
      }
      ctx.progress({ label: `Waiting out Figma’s rate limit (${wait}s)…` });
      await sleep(wait * 1000, ctx.signal);
      continue;
    }
    if (res.status === 403) throw new GrabError('AUTH', 'Figma didn’t accept the token for this file. Check the token has “File content: Read” access and that your account can open the file.');
    if (res.status === 404) throw new GrabError('NOT_FOUND', 'Figma couldn’t find that file or section. Check the link and your access.');
    if (!res.ok) throw new GrabError('API', `Figma returned an error (${res.status}). Try again in a moment.`);
    return res.json();
  }
}

async function downloadTo(ctx, src, file) {
  for (let attempt = 0; ; attempt++) {
    ctx.signal?.throwIfAborted();
    try {
      const res = await ctx.fetch(src, { signal: ctx.signal });
      if (!res.ok) throw new Error(`download ${res.status}`);
      await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (e) {
      if (ctx.signal?.aborted || attempt >= 2) throw e;
      await sleep(1000 * (attempt + 1), ctx.signal);
    }
  }
}

// ---------- structure ----------

// Descend only through Pages/Sections. The first non-section node (frame, group, instance…) is one chunk.
function findChunks(skeleton) {
  const info = (n, group) => ({ id: n.id, name: n.name, type: n.type, group });
  if (!CONTAINERS.has(skeleton.type)) return [info(skeleton, [])];
  const out = [];
  (function walk(node, group, level) {
    for (const k of node.children || []) {
      if (CONTAINERS.has(k.type) && (k.children || []).length && level < MAX_DEPTH) walk(k, [...group, k.name], level + 1);
      else out.push(info(k, group));
    }
  })(skeleton, [], 1);
  return out.length ? out : [info(skeleton, [])];
}

const strip = (n) => {
  for (const k of STRIP_FOR_SLIM) delete n[k];
  (n.children || []).forEach(strip);
};

// ---------- main ----------

/**
 * @param {object} o
 * @param {string} o.url        Figma link (should include node-id)
 * @param {string} o.token      Figma personal access token
 * @param {string} o.outRoot    folder under which a per-link folder is created
 * @param {Function} o.fetch    fetch implementation (Electron's net.fetch in the app)
 * @param {AbortSignal} [o.signal]
 * @param {Function} [o.onProgress]  ({label, pct, done, total}) => void
 * @param {boolean} [o.split=true]   break very long pages into sections
 */
async function grab({ url, token, outRoot, fetch, signal, onProgress, split = true }) {
  if (!token) throw new GrabError('NO_TOKEN', 'Add your Figma token first.');
  let last = { label: '', pct: 0 };
  const progress = (p) => { last = { ...last, ...p }; onProgress?.(last); };
  const ctx = { token, fetch, signal, progress };

  const link = parseFigmaUrl(url);
  progress({ label: 'Reading the file structure', pct: 3, done: null, total: null });

  if (!link.nodeId) {
    const f = await api(ctx, `/v1/files/${link.fileKey}?depth=1`);
    const pages = (f.document?.children || []).map((p) => ({ id: p.id, name: p.name, url: nodeLink(link, p.id) }));
    throw new GrabError('NO_NODE', 'This link points at the whole file. Pick a page to pull from:', { pages, fileName: f.name });
  }

  const rootRes = await api(ctx, `/v1/files/${link.fileKey}/nodes?ids=${enc(link.nodeId)}&depth=${MAX_DEPTH + 1}`);
  const rootNode = rootRes.nodes?.[link.nodeId];
  if (!rootNode?.document) throw new GrabError('NOT_FOUND', 'That page or section isn’t in this file. Copy the link again from Figma.');
  const skeleton = rootNode.document;
  const fileName = rootRes.name || 'Figma file';
  const chunks = findChunks(skeleton);
  chunks.forEach((c, i) => {
    c.base = `${String(i + 1).padStart(3, '0')}_${slug([...c.group, c.name].join('__'))}`;
    c.url = nodeLink(link, c.id);
    c.json = null; c.jsonSlim = null; c.png = null; c.width = null; c.height = null;
    c.title = c.name; c.parentId = null; c.split = false;
  });

  const outDir = path.join(outRoot, `${slug(fileName)}__${slug(skeleton.name)}`);
  if (path.dirname(outDir) !== path.resolve(outRoot)) throw new GrabError('PATH', 'Unsafe output path.');
  for (const d of ['nodes', 'nodes-slim', 'renders', 'assets']) await fs.rm(path.join(outDir, d), { recursive: true, force: true });
  for (const d of ['nodes', 'nodes-slim', 'renders', 'assets']) await fs.mkdir(path.join(outDir, d), { recursive: true });
  await fs.writeFile(path.join(outDir, 'skeleton.json'), JSON.stringify(skeleton));

  const total0 = chunks.length;
  const usedRefs = new Set();
  const all = []; // frames in reading order, each followed by its auto-split sections

  const writeNode = async (c, wrapper) => {
    const full = JSON.stringify(wrapper);
    await fs.writeFile(path.join(outDir, 'nodes', `${c.base}.json`), full);
    const slim = JSON.parse(full);
    strip(slim.document);
    await fs.writeFile(path.join(outDir, 'nodes-slim', `${c.base}.json`), JSON.stringify(slim));
    c.json = `nodes/${c.base}.json`;
    c.jsonSlim = `nodes-slim/${c.base}.json`;
    return full;
  };
  const measure = (c, doc) => {
    const e = extentOf(doc);
    if (e) { c.width = Math.round(e.width); c.height = Math.round(e.height); }
    c.title = titleFor(doc);
  };

  // 1. Node JSON (batched). Long pages are split into sections from this same data (no extra API calls).
  let done = 0;
  for (const group of chunkArray(chunks, JSON_BATCH)) {
    progress({ label: 'Fetching layout details', done, total: total0, pct: 8 + (done / total0) * 37 });
    const data = await api(ctx, `/v1/files/${link.fileKey}/nodes?ids=${group.map((c) => enc(c.id)).join(',')}&geometry=paths`);
    for (const c of group) {
      all.push(c);
      const n = data.nodes?.[c.id];
      if (!n) continue;
      const full = await writeNode(c, n);
      for (const m of full.matchAll(/"imageRef":"([0-9a-f]+)"/g)) usedRefs.add(m[1]);
      measure(c, n.document);

      const parts = split ? splitSections(n.document) : null;
      if (!parts) continue;
      c.split = true;
      c.title = 'Full page';
      c.group = [...c.group, c.name];
      parts.forEach((p, k) => {
        const sc = {
          id: p.id, name: p.name, type: p.type, group: c.group, url: nodeLink(link, p.id),
          base: `${c.base}__${String(k + 1).padStart(2, '0')}_${slug(p.name)}`,
          json: null, jsonSlim: null, png: null, width: null, height: null, title: p.name, parentId: c.id, split: false,
        };
        measure(sc, p);
        all.push(sc);
        sc._doc = { ...n, document: p };
      });
      for (const sc of all.filter((x) => x.parentId === c.id)) {
        await writeNode(sc, sc._doc);
        delete sc._doc;
      }
    }
    done += group.length;
  }

  // 2. Screenshots (batched; very large frames fall back to a smaller scale)
  const renderUrls = async (ids, scale) => {
    const r = await api(ctx, `/v1/images/${link.fileKey}?ids=${ids.map(enc).join(',')}&format=png&scale=${scale}`);
    return r.images || {};
  };
  const total = all.length;
  done = 0;
  for (const group of chunkArray(all, RENDER_BATCH)) {
    progress({ label: 'Capturing screenshots', done, total, pct: 45 + (done / total) * 42 });
    let urls = await renderUrls(group.map((c) => c.id), 2).catch((e) => { if (e.code) throw e; return {}; });
    for (const c of group.filter((c) => !urls[c.id])) {
      for (const scale of [1, 0.5, 0.25]) {
        const one = await renderUrls([c.id], scale).catch(() => ({}));
        if (one[c.id]) { urls[c.id] = one[c.id]; break; }
      }
    }
    await pool(group, DOWNLOAD_CONCURRENCY, async (c) => {
      if (!urls[c.id]) return;
      try {
        const file = path.join(outDir, 'renders', `${c.base}.png`);
        await downloadTo(ctx, urls[c.id], file);
        c.png = `renders/${c.base}.png`;
        const sz = await pngSize(file).catch(() => null);
        if (sz) { c.imgWidth = sz.w; c.imgHeight = sz.h; if (c.width) c.scale = Math.round((sz.w / c.width) * 100) / 100; }
      } catch (e) { if (ctx.signal?.aborted) throw e; }
    });
    done += group.length;
  }

  // 3. Image fills used by these screens + published styles (best effort)
  progress({ label: 'Saving images and styles', done: null, total: null, pct: 90 });
  try {
    if (usedRefs.size) {
      const all = (await api(ctx, `/v1/files/${link.fileKey}/images`)).meta?.images || {};
      const wanted = Object.entries(all).filter(([ref]) => usedRefs.has(ref));
      await fs.writeFile(path.join(outDir, 'image-fills.json'), JSON.stringify(Object.fromEntries(wanted)));
      await pool(wanted, DOWNLOAD_CONCURRENCY, async ([ref, src]) => {
        await downloadTo(ctx, src, path.join(outDir, 'assets', `${ref}.png`)).catch((e) => { if (ctx.signal?.aborted) throw e; });
      });
    }
    const styles = (await api(ctx, `/v1/files/${link.fileKey}/styles`)).meta;
    await fs.writeFile(path.join(outDir, 'styles.json'), JSON.stringify(styles ?? {}));
  } catch (e) {
    if (ctx.signal?.aborted || e.code === 'RATE_LIMIT') throw e; // fills/styles are optional; other errors are ignored
  }

  const result = {
    fileKey: link.fileKey,
    fileName,
    rootId: link.nodeId,
    rootName: skeleton.name,
    rootUrl: nodeLink(link, link.nodeId),
    createdAt: new Date().toISOString(),
    outDir,
    chunks: all.map((c) => ({
      id: c.id, name: c.name, title: c.title, type: c.type, group: c.group, url: c.url, parentId: c.parentId, split: c.split,
      width: c.width, height: c.height, scale: c.scale ?? null, imgWidth: c.imgWidth ?? null, imgHeight: c.imgHeight ?? null,
      json: c.json, jsonSlim: c.jsonSlim, png: c.png,
      small: NOT_A_SCREEN.has(c.type) || !c.png || (c.width != null && c.height != null && (c.width < 24 || c.height < 24)),
    })),
  };
  await fs.writeFile(path.join(outDir, 'index.json'), JSON.stringify(result, null, 2));
  progress({ label: 'Finishing up', done: total, total, pct: 96 });
  return result;
}

module.exports = { grab, parseFigmaUrl, findChunks, GrabError, slug };
