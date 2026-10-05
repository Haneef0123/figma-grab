#!/usr/bin/env node
// Extracts a whole Figma page/file section by section using the REST API.
// Usage: FIGMA_TOKEN=... node figma-extract.mjs "<figma url>" [outDir] [--depth=N]
//   --depth=N  max levels to descend below the linked node (default 4). Descent only goes through
//              SECTIONs and stops at the first frame, so each screen is one chunk at any nesting depth.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const TOKEN = process.env.FIGMA_TOKEN;
const args = process.argv.slice(2);
const url = (args.find((a) => a.startsWith("http")) || "").replace(/\\/g, ""); // drop stray backslashes from shell-escaped links
const outDir = args.find((a) => !a.startsWith("http") && !a.startsWith("--")) || "figma-out";
const depth = Number((args.find((a) => a.startsWith("--depth=")) || "--depth=4").split("=")[1]);

if (!TOKEN || !url) {
  console.error('Usage: FIGMA_TOKEN=... node figma-extract.mjs "<figma url>" [outDir] [--depth=N]');
  process.exit(1);
}

const u = new URL(url);
const parts = u.pathname.split("/").filter(Boolean);
const fileKey = parts[2] === "branch" ? parts[3] : parts[1]; // /design/KEY/name or /design/KEY/branch/BRANCHKEY/name
const nodeParam = u.searchParams.get("node-id");
const rootId = nodeParam ? nodeParam.replace("-", ":") : null;

const MAX_WAIT_S = 120; // if Figma asks us to wait longer than this, stop instead of hanging
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p) {
  for (let attempt = 0; attempt < 6; attempt++) {
    let res;
    try {
      res = await fetch(`https://api.figma.com${p}`, { headers: { "X-Figma-Token": TOKEN } });
    } catch (e) {
      if (attempt >= 2) throw new Error(`Network error: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`);
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") || 10);
      if (wait > MAX_WAIT_S) {
        throw new Error(
          `Rate limited by Figma: retry-after ${wait}s (~${Math.round(wait / 3600)}h). ` +
            `This usually means your seat/plan has a very low REST API quota. Try again later or use a Full/Dev seat token.`
        );
      }
      console.warn(`Rate limited, waiting ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 403) throw new Error(`403 Forbidden: check the token and that it has the file_content:read scope. ${await res.text()}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${p}: ${await res.text()}`);
    return res.json();
  }
  throw new Error(`Gave up on ${p}`);
}

const slug = (s) => s.replace(/[^\w-]+/g, "_").slice(0, 60) || "unnamed";
const write = async (rel, data) => {
  const f = path.join(outDir, rel);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data));
};
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const download = async (src) => Buffer.from(await (await fetch(src)).arrayBuffer());

// 1. Light skeleton (names/ids only) so nothing overflows.
if (!rootId) {
  const pages = (await api(`/v1/files/${fileKey}?depth=1`)).document.children || [];
  console.error(`This link has no node-id, so it points at the whole file (${pages.length} pages). Refusing to pull everything.`);
  console.error("In Figma, right-click the page/section/frame -> Copy link to selection, then re-run. Pages in this file:");
  for (const pg of pages) console.error(`  ${pg.name}  ->  ${u.origin}${u.pathname}?node-id=${pg.id.replace(":", "-")}`);
  process.exit(1);
}
const rootRes = (await api(`/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(rootId)}&depth=${depth + 1}`)).nodes[rootId];
if (!rootRes) {
  console.error(`node-id ${rootId} does not exist in file ${fileKey}. Check that the link is copied from THIS file.`);
  process.exit(1);
}
const skeleton = rootRes.document;

// 2. Chunks = every node `depth` levels below the root (or a leaf reached earlier).
const chunks = [];
(function walk(node, level, trail) {
  const kids = node.children || [];
  // Descend only through SECTIONs (organisational containers); a FRAME/INSTANCE/etc. is a screen or component = one chunk.
  if (level === depth || kids.length === 0 || (node !== skeleton && node.type !== "SECTION")) {
    if (node !== skeleton) chunks.push({ id: node.id, name: node.name, type: node.type, trail });
    return;
  }
  for (const k of kids) walk(k, level + 1, [...trail, k.name]);
})(skeleton, 0, []);
if (chunks.length === 0) chunks.push({ id: skeleton.id, name: skeleton.name, type: skeleton.type, trail: [] });

chunks.forEach((c, i) => (c.base = `${String(i + 1).padStart(3, "0")}_${slug(c.trail.join("__") || c.name)}`));
console.log(`Found ${chunks.length} chunks under "${skeleton.name}"`);
await write("skeleton.json", skeleton);

const usedRefs = new Set();
const byId = Object.fromEntries(chunks.map((c) => [c.id, { ...c, json: null, png: null }]));

// 3a. Full node JSON, batched (8 chunks per request).
for (const [i, group] of chunk(chunks, 8).entries()) {
  process.stdout.write(`JSON batch ${i + 1}/${Math.ceil(chunks.length / 8)} ... `);
  try {
    const data = await api(`/v1/files/${fileKey}/nodes?ids=${group.map((c) => encodeURIComponent(c.id)).join(",")}&geometry=paths`);
    for (const c of group) {
      const n = data.nodes[c.id];
      if (!n) continue;
      await write(`nodes/${c.base}.json`, n);
      for (const m of JSON.stringify(n).matchAll(/"imageRef":"([0-9a-f]+)"/g)) usedRefs.add(m[1]);
      byId[c.id].json = `nodes/${c.base}.json`;
    }
    console.log("ok");
  } catch (e) {
    console.log("FAILED", e.message.slice(0, 200));
    if (e.message.startsWith("Rate limited")) break;
  }
}

// 3b. PNG renders are done by figma-finish.mjs (curl-based; Node 18 fetch cannot download them reliably).

// 4. Image fills (photos/illustrations used in the design) and published styles.
try {
  const allFills = (await api(`/v1/files/${fileKey}/images`)).meta.images || {};
  const fills = Object.fromEntries(Object.entries(allFills).filter(([ref]) => usedRefs.has(ref))); // only fills used by these chunks
  await write("image-fills.json", fills);
  let i = 0;
  for (const [ref, src] of Object.entries(fills)) {
    i++;
    await write(`assets/${ref}.png`, await download(src));
  }
  console.log(`Downloaded ${i} image fills`);
} catch (e) {
  console.warn("Image fills skipped:", e.message.slice(0, 160));
}
try {
  await write("styles.json", (await api(`/v1/files/${fileKey}/styles`)).meta);
} catch (e) {
  console.warn("Styles skipped:", e.message.slice(0, 160));
}

await write("index.json", Object.values(byId));
if (!Object.values(byId).some((c) => c.json)) {
  console.error("No node JSON was fetched - see errors above. Nothing else to do.");
  process.exit(1);
}
console.log(`Done. Output in ${path.resolve(outDir)}`);
