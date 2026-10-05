// Stand-in for the Electron preload bridge so the real UI can be viewed in a plain browser.
// ?token=none shows the connect screen. URL containing "whole" -> page picker, "bad" -> auth error, anything else -> results.
(() => {
  const params = new URLSearchParams(location.search);
  const base = '/test/fixtures/stock';
  let progressCb = null, cancelled = false;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.api = {
    tokenStatus: async () => ({ saved: params.get('token') !== 'none' }),
    saveToken: async () => ({ ok: true }),
    clearToken: async () => ({ ok: true }),
    onProgress: (cb) => { progressCb = cb; return () => { progressCb = null; }; },
    cancel: async () => { cancelled = true; },
    openFigma: async (u) => console.log('openFigma', u),
    openFolder: async (d) => console.log('openFolder', d),
    start: async (url) => {
      cancelled = false;
      if (url.includes('bad')) { await wait(400); return { ok: false, error: { code: 'AUTH', message: 'Figma didn’t accept the token for this file. Check the token has “File content: Read” access and that your account can open the file.' } }; }
      if (url.includes('whole')) { await wait(400); return { ok: false, error: { code: 'NO_NODE', message: 'This link points at the whole file. Pick a page to pull from:', pages: [{ name: 'Key flows', url: 'x' }, { name: 'Explorations', url: 'x' }, { name: 'Archive', url: 'x' }] } }; }
      const steps = [['Reading the file structure', 3, null], ['Fetching layout details', 25, 'n'], ['Capturing screenshots', 66, 'n'], ['Saving images and styles', 90, null]];
      const total = 26;
      for (const [label, pct, count] of steps) {
        if (cancelled) return { ok: false, cancelled: true };
        progressCb?.({ label, pct, done: count ? 11 : null, total: count ? total : null });
        await wait(params.get('slow') ? 60000 : 500);
      }
      if (params.get('fixture') === 'sd') { // a real result from the app's own run (new index format)
        const idx = await (await fetch('/test/fixtures/sd/index.json')).json();
        const b = '/test/fixtures/sd';
        idx.chunks = idx.chunks.map((c) => ({ ...c, image: c.png ? `${b}/${c.png}` : null, thumb: c.thumb ? `${b}/${c.thumb}` : null, thumbs: c.thumbs ? c.thumbs.map((t) => `${b}/${t}`) : null }));
        return { ok: true, result: { ...idx, outDir: '/x' } };
      }
      const old = await (await fetch(`${base}/index.json`)).json();
      const chunks = old.map((c) => ({
        id: c.id, name: c.name, type: c.type, group: c.trail.slice(0, -1), url: `https://www.figma.com/design/KEY/Name?node-id=${c.id.replace(':', '-')}`,
        width: c.type === 'FRAME' ? (/mobile/i.test(c.name) ? 390 : 1440) : null, height: c.type === 'FRAME' ? (/mobile/i.test(c.name) ? 844 : 900) : null,
        png: c.png, image: c.png ? `${base}/${c.png}` : null,
        small: ['VECTOR', 'LINE'].includes(c.type) || !c.png,
      }));
      return { ok: true, result: { fileName: 'Stock Comparison', rootName: 'Key flows', outDir: '/x', chunks } };
    },
  };
})();
