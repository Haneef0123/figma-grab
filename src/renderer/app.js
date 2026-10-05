'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const views = ['token', 'home', 'loading', 'results'];
  const state = { result: null, showSmall: false, offProgress: null };

  function show(name) {
    for (const v of views) $(`view-${v}`).hidden = v !== name;
    const focus = { token: 'token-input', home: 'url-input' }[name];
    if (focus) setTimeout(() => $(focus).focus(), 30);
  }

  function setNotice(el, text) {
    el.textContent = text || '';
    el.hidden = !text;
  }

  // ---------------- token ----------------
  $('token-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setNotice($('token-notice'), '');
    const res = await window.api.saveToken($('token-input').value);
    if (!res.ok) return setNotice($('token-notice'), res.message);
    $('token-input').value = '';
    show('home');
  });
  $('token-help').addEventListener('click', () => window.api.openFigma('https://www.figma.com/developers/api#access-tokens'));
  $('change-token').addEventListener('click', async () => {
    await window.api.clearToken();
    show('token');
  });

  // ---------------- home ----------------
  const splitBox = $('opt-split');
  try { splitBox.checked = localStorage.getItem('splitLong') !== '0'; } catch { /* storage unavailable */ }
  splitBox.addEventListener('change', () => { try { localStorage.setItem('splitLong', splitBox.checked ? '1' : '0'); } catch { /* ignore */ } });
  const urlInput = $('url-input');
  urlInput.addEventListener('input', () => {
    $('start-btn').disabled = !urlInput.value.trim();
    setNotice($('home-notice'), '');
    $('pages').hidden = true;
  });
  $('home-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (urlInput.value.trim()) run(urlInput.value.trim());
  });

  async function run(url) {
    setNotice($('home-notice'), '');
    $('pages').hidden = true;
    setProgress({ label: 'Starting…', pct: 2 });
    show('loading');
    state.offProgress?.();
    state.offProgress = window.api.onProgress(setProgress);

    const res = await window.api.start(url, { split: splitBox.checked });
    state.offProgress?.();
    state.offProgress = null;

    if (res.ok) return showResults(res.result);
    show('home');
    if (res.cancelled) return;
    setNotice($('home-notice'), res.error.message);
    if (res.error.code === 'NO_NODE' && res.error.pages?.length) renderPages(res.error.pages);
    if (res.error.code === 'AUTH' || res.error.code === 'NO_TOKEN') {
      const retry = document.createElement('button');
      retry.className = 'link'; retry.type = 'button'; retry.textContent = ' Change token';
      retry.addEventListener('click', () => $('change-token').click());
      $('home-notice').append(retry);
    }
  }

  function renderPages(pages) {
    const ul = $('pages');
    ul.replaceChildren(
      ...pages.map((p) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = p.name;
        b.addEventListener('click', () => { urlInput.value = p.url; run(p.url); });
        li.append(b);
        return li;
      })
    );
    ul.hidden = false;
  }

  // ---------------- loading ----------------
  function setProgress(p) {
    if (p.label) $('loading-label').textContent = p.label;
    if (typeof p.pct === 'number') {
      $('bar-fill').style.width = `${Math.max(2, Math.min(100, p.pct))}%`;
      document.querySelector('.bar').setAttribute('aria-valuenow', String(Math.round(p.pct)));
    }
    $('loading-count').textContent = p.total ? `${Math.min(p.done ?? 0, p.total)} of ${p.total}` : ' ';
  }
  $('cancel-btn').addEventListener('click', () => window.api.cancel());

  // ---------------- results ----------------
  $('back-btn').addEventListener('click', () => { urlInput.select(); show('home'); });
  $('folder-btn').addEventListener('click', () => state.result && window.api.openFolder(state.result.outDir));

  function showResults(result) {
    state.result = result;
    state.showSmall = false;
    renderResults();
    show('results');
    window.scrollTo(0, 0);
  }

  function renderResults() {
    const r = state.result;
    const visible = r.chunks.filter((c) => state.showSmall || !c.small);
    const hiddenCount = r.chunks.length - r.chunks.filter((c) => !c.small).length;

    $('res-title').textContent = r.rootName;
    const shown = r.chunks.filter((c) => !c.small);
    const pages = shown.filter((c) => c.split).length;
    const parts = shown.filter((c) => c.parentId).length;
    $('res-sub').textContent = `${r.fileName} · ${shown.length} card${shown.length === 1 ? '' : 's'}` +
      (parts ? ` (${parts} section${parts === 1 ? '' : 's'} split from ${pages} long page${pages === 1 ? '' : 's'})` : '');

    const groups = new Map();
    for (const c of visible) {
      const key = c.group.join(' › ');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const nodes = [];
    for (const [title, items] of groups) {
      const section = document.createElement('section');
      section.className = 'group';
      if (groups.size > 1 || title) {
        const h = document.createElement('h3');
        h.className = 'group-title';
        h.textContent = title || 'Top level';
        const n = document.createElement('span');
        n.textContent = String(items.length);
        h.append(n);
        section.append(h);
      }
      const grid = document.createElement('div');
      grid.className = 'grid';
      for (const c of items) grid.append(card(c));
      section.append(grid);
      nodes.push(section);
    }
    $('groups').replaceChildren(...nodes);

    const note = $('small-note');
    if (hiddenCount > 0) {
      note.hidden = false;
      note.textContent = state.showSmall
        ? 'Showing everything, including small elements like lines and icons. '
        : `${hiddenCount} small element${hiddenCount === 1 ? '' : 's'} (lines, icons) are saved but hidden. `;
      const t = document.createElement('button');
      t.className = 'link'; t.type = 'button';
      t.textContent = state.showSmall ? 'Hide them' : 'Show them';
      t.addEventListener('click', () => { state.showSmall = !state.showSmall; renderResults(); });
      note.append(t);
    } else {
      note.hidden = true;
    }
  }

  function card(c) {
    const el = document.createElement('article');
    el.className = c.split ? 'card page' : 'card';

    const thumb = document.createElement('button');
    thumb.className = 'thumb';
    thumb.type = 'button';
    thumb.setAttribute('aria-label', `Preview ${c.title}`);
    if (c.thumbs?.length) {
      thumb.classList.add('strip');
      for (const src of c.thumbs) {
        const img = document.createElement('img');
        img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.src = src;
        thumb.append(img);
      }
    } else if (c.image) {
      const img = document.createElement('img');
      img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
      img.addEventListener('load', () => img.classList.toggle('tall', img.naturalHeight > img.naturalWidth * 1.1));
      img.src = c.thumb || c.image;
      thumb.append(img);
    }
    thumb.addEventListener('click', () => c.image && openLightbox(c));

    const meta = document.createElement('div');
    meta.className = 'meta';
    const txt = document.createElement('div');
    txt.className = 'txt';
    const name = document.createElement('div');
    name.className = 'name'; name.textContent = c.title || c.name;
    name.title = c.title && c.title !== c.name ? `${c.title} (layer: ${c.name})` : c.name;
    const dims = document.createElement('div');
    dims.className = 'dims';
    dims.textContent = c.width && c.height ? `${c.width} × ${c.height}` : c.type.toLowerCase().replace(/_/g, ' ');
    if (c.scale && c.scale < 1.9) {
      const w = document.createElement('span');
      w.className = 'warn'; w.textContent = ` · rendered at ${c.scale}×`;
      w.title = 'Figma limits image size, so this long page was rendered smaller than 2×.';
      dims.append(w);
    }
    txt.append(name, dims);
    const open = document.createElement('button');
    open.className = 'open'; open.type = 'button'; open.textContent = 'Open in Figma ↗';
    open.addEventListener('click', () => window.api.openFigma(c.url));
    meta.append(txt, open);

    el.append(thumb, meta);
    return el;
  }

  // ---------------- lightbox ----------------
  const lb = $('lightbox');
  let lbChunk = null;
  function openLightbox(c) {
    lbChunk = c;
    const img = $('lightbox-img');
    img.className = '';
    img.style.width = '';
    $('lightbox-frame').scrollTop = 0;
    img.onload = () => {
      // Long pages: show at (about) design size and scroll, instead of shrinking to an unreadable sliver.
      if (img.naturalHeight > img.naturalWidth * 1.4) {
        const designW = img.naturalWidth / (c.scale || 2);
        img.className = 'scrolls';
        img.style.width = `${Math.round(Math.min(designW, window.innerWidth * 0.88))}px`;
      }
    };
    img.src = c.image;
    $('lightbox-name').textContent = c.title || c.name;
    lb.showModal();
  }
  lb.addEventListener('click', (e) => { if (e.target === lb) lb.close(); });
  $('lightbox-open').addEventListener('click', () => lbChunk && window.api.openFigma(lbChunk.url));

  // ---------------- boot ----------------
  (async () => {
    const { saved } = await window.api.tokenStatus();
    show(saved ? 'home' : 'token');
  })();
})();
