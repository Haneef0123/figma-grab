'use strict';
// Pure helpers (no Electron / no network) that work on a Figma REST node tree:
//  - extentOf:      real visible content size of a node (frames that don't clip let content overflow their box)
//  - splitSections: break a very long page into section-sized pieces
//  - titleFor:      a human title for a node (falls back to its first heading text when the layer name is generic)

const SPLIT_MIN_H = 1800; // a node whose content is taller than this (design px) gets broken into sections
const SECTION_MAX_H = 1200; // stop descending once a piece is at most this tall
const MIN_H = 40; // ignore slivers (dividers, spacers)
const MIN_W = 100;
const MAX_PIECES = 60; // if a split would produce more than this, coarsen it instead
const PIECE_TYPES = new Set(['FRAME', 'GROUP', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET', 'SECTION']);
const GENERIC_NAME = /^(container|frame\s*\d*|group\s*\d*|section|content|wrapper|layout|stack|row|column|inner|body|main|rectangle\s*\d*|\.|-+)$/i;

// ---------- geometry ----------
const rectOf = (n) => {
  const b = n.absoluteBoundingBox;
  return b ? { x1: b.x, y1: b.y, x2: b.x + b.width, y2: b.y + b.height } : null;
};
const unionRect = (a, b) => ({ x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) });
const intersectRect = (a, b) => {
  const r = { x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2) };
  return r.x2 > r.x1 && r.y2 > r.y1 ? r : null;
};

const extentCache = new WeakMap();
function extentRect(n) {
  if (extentCache.has(n)) return extentCache.get(n);
  let r = rectOf(n);
  for (const k of n.children || []) {
    if (k.visible === false) continue;
    let kr = extentRect(k);
    if (kr && n.clipsContent && r) kr = intersectRect(kr, r); // clipped content isn't visible
    if (kr) r = r ? unionRect(r, kr) : kr;
  }
  extentCache.set(n, r);
  return r;
}

function extentOf(n) {
  const r = extentRect(n);
  return r ? { x: r.x1, y: r.y1, width: r.x2 - r.x1, height: r.y2 - r.y1 } : null;
}

// ---------- splitting ----------
function pieces(n) {
  return (n.children || []).filter((k) => {
    if (k.visible === false || !PIECE_TYPES.has(k.type)) return false;
    const e = extentOf(k);
    return e && e.height >= MIN_H && e.width >= MIN_W;
  });
}

/** Returns an array of descendant nodes that are section-sized pieces, in reading order, or null if it shouldn't be split. */
function splitSections(doc) {
  const ext = extentOf(doc);
  if (!ext || ext.height <= SPLIT_MIN_H) return null;
  for (let max = SECTION_MAX_H, tries = 0; tries < 3; tries++, max *= 2) {
    const out = [];
    const expand = (n, isRoot) => {
      const e = extentOf(n);
      const kids = pieces(n);
      if ((!isRoot && e.height <= max) || kids.length === 0) return void out.push(n);
      if (kids.length === 1) return expand(kids[0], false); // plain wrapper: look inside it
      for (const k of kids) expand(k, false);
    };
    expand(doc, true);
    if (out.length > MAX_PIECES) continue; // too fragmented: retry with larger sections
    if (out.length <= 1 || (out.length === 1 && out[0] === doc)) return null;
    return out.sort((a, b) => {
      const ea = extentOf(a), eb = extentOf(b);
      return Math.round(ea.y / 10) - Math.round(eb.y / 10) || ea.x - eb.x;
    });
  }
  return null;
}

// ---------- titles ----------
function headingText(node) {
  const texts = [];
  (function walk(n) {
    if (n.visible === false) return;
    if (n.type === 'TEXT' && n.characters && n.absoluteBoundingBox) {
      const t = n.characters.replace(/\s+/g, ' ').trim();
      if (t && !/^[\d₹$€£%.,+\-–\s:/]+$/.test(t)) texts.push({ t, size: n.style?.fontSize || 0, x: n.absoluteBoundingBox.x, y: n.absoluteBoundingBox.y });
    }
    for (const k of n.children || []) walk(k);
  })(node);
  if (!texts.length) return null;
  const top = Math.min(...texts.map((t) => t.y));
  const band = texts.filter((t) => t.y <= top + 80);
  const biggest = Math.max(...band.map((t) => t.size));
  const heads = band.filter((t) => t.size >= biggest - 0.5).sort((a, b) => a.x - b.x);
  const picked = [];
  for (const h of heads) {
    if (!picked.length || h.x - picked[picked.length - 1].x > 150) picked.push(h);
    if (picked.length === 2) break; // two side-by-side cards share a row
  }
  const s = picked.map((p) => p.t).join(' · ');
  return s.length > 56 ? s.slice(0, 55) + '…' : s;
}

function titleFor(node) {
  const name = String(node.name || '').trim();
  return GENERIC_NAME.test(name) ? headingText(node) || name || 'Untitled' : name;
}

module.exports = { extentOf, splitSections, titleFor, headingText, SPLIT_MIN_H, SECTION_MAX_H };
