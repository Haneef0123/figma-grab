#!/usr/bin/env node
// Follow-up to figma-extract.mjs. Reads <outDir>/index.json and:
//   1. renders PNGs in small batches with retries (and prints the real error cause),
//   2. minifies nodes/*.json in place (pretty-printing made them ~4x bigger),
//   3. writes nodes-slim/*.json without vector path data (vectorNetwork, fill/strokeGeometry).
// Usage: FIGMA_TOKEN=... node figma-finish.mjs "<figma url>" [outDir] [--scale=2] [--batch=4]

import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspect } from "node:util";
const execFileP = promisify(execFile);

const TOKEN = process.env.FIGMA_TOKEN;
const args = process.argv.slice(2);
const url = (args.find((a) => a.startsWith("http")) || "").replace(/\\/g, "");
const outDir = args.find((a) => !a.startsWith("http") && !a.startsWith("--")) || "figma-out";
const opt = (n, d) => Number((args.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split("=")[1]);
const scale = opt("scale", 2);
const batchSize = opt("batch", 4);

if (!TOKEN || !url) {
  console.error('Usage: FIGMA_TOKEN=... node figma-finish.mjs "<figma url>" [outDir] [--scale=2] [--batch=4]');
  process.exit(1);
}
const fparts = new URL(url).pathname.split("/").filter(Boolean);
const fileKey = fparts[2] === "branch" ? fparts[3] : fparts[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const why = (e) => {
  const c = e.cause;
  const detail = c ? (c.errors ? c.errors.map((x) => x.code || x.message).join(", ") : c.code || c.message || inspect(c, { depth: 1 })) : "";
  return `${e.message}${detail ? ` (cause: ${detail})` : ""}${e.stderr ? ` ${String(e.stderr).trim()}` : ""}`;
};
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const out = (rel) => path.join(outDir, rel);

async function withRetry(label, fn, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === tries) throw e;
      console.warn(`  ${label} attempt ${i} failed: ${why(e)} — retrying`);
      await sleep(2000 * i);
    }
  }
}

async function api(p) {
  const res = await fetch(`https://api.figma.com${p}`, { headers: { "X-Figma-Token": TOKEN } });
  if (res.status === 429) throw new Error(`Rate limited, retry-after ${res.headers.get("retry-after")}s`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
// curl uses the system network stack (IPv4/IPv6 fallback, proxies), which Node 18.0's built-in fetch handles poorly.
async function download(src, file) {
  await execFileP("curl", ["-sS", "-L", "--fail", "--retry", "2", "--max-time", "120", "-o", file, src]);
}

const index = JSON.parse(await readFile(out("index.json"), "utf8"));
await mkdir(out("renders"), { recursive: true });

// 1. Renders
const todo = index.filter((c) => !c.png);
console.log(`Rendering ${todo.length} chunks at ${scale}x in batches of ${batchSize}`);
for (const [bi, group] of chunk(todo, batchSize).entries()) {
  process.stdout.write(`[${bi + 1}/${Math.ceil(todo.length / batchSize)}] `);
  try {
    const img = await withRetry("images api", () =>
      api(`/v1/images/${fileKey}?ids=${group.map((c) => encodeURIComponent(c.id)).join(",")}&format=png&scale=${scale}`)
    );
    for (const c of group) {
      const src = img.images?.[c.id];
      if (!src) {
        console.log(`\n  no render for "${c.name}" (${c.id})`);
        continue;
      }
      try {
        await withRetry("download", () => download(src, out(`renders/${c.base}.png`)));
        c.png = `renders/${c.base}.png`;
      } catch (e) {
        console.log(`\n  download failed for "${c.name}": ${why(e)}`);
      }
    }
    console.log("ok");
  } catch (e) {
    console.log("FAILED", why(e));
    if (e.message.startsWith("Rate limited")) break;
  }
  await writeFile(out("index.json"), JSON.stringify(index, null, 2)); // save progress
}

// 2 + 3. Minify and slim
const STRIP = new Set(["vectorNetwork", "vectorPaths", "fillGeometry", "strokeGeometry"]);
const strip = (n) => {
  for (const k of STRIP) delete n[k];
  (n.children || []).forEach(strip);
  return n;
};
await mkdir(out("nodes-slim"), { recursive: true });
let before = 0, after = 0, slim = 0;
for (const f of (await readdir(out("nodes")).catch(() => [])).filter((f) => f.endsWith(".json"))) {
  const raw = await readFile(out(`nodes/${f}`), "utf8");
  const data = JSON.parse(raw);
  const min = JSON.stringify(data);
  await writeFile(out(`nodes/${f}`), min);
  const s = JSON.stringify(strip(data.document) && data);
  await writeFile(out(`nodes-slim/${f}`), s);
  before += raw.length; after += min.length; slim += s.length;
}
console.log(`JSON: ${(before / 1048576).toFixed(0)} MB -> ${(after / 1048576).toFixed(0)} MB minified, ${(slim / 1048576).toFixed(0)} MB slim`);
const ok = index.filter((c) => c.png).length;
console.log(`Renders: ${ok}/${index.length}. Done.`);
