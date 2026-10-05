'use strict';
const { app, BrowserWindow, ipcMain, shell, safeStorage, protocol, net, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { grab, GrabError } = require('./core');
const { makeThumbs } = require('./thumbs');

app.setName('Figma Grab');
protocol.registerSchemesAsPrivileged([{ scheme: 'grab', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const outRoot = () => path.join(app.getPath('documents'), 'Figma Grab');
const tokenFile = () => path.join(app.getPath('userData'), 'token.bin');
const isInside = (child, parent) => { const rel = path.relative(parent, child); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
const imageUrl = (abs) => 'grab://f' + abs.split('/').map(encodeURIComponent).join('/');

// ---- token (encrypted with the macOS Keychain via safeStorage) ----
function loadToken() {
  try {
    if (fs.existsSync(tokenFile())) return safeStorage.decryptString(fs.readFileSync(tokenFile()));
  } catch { /* unreadable token = treat as not saved */ }
  return process.env.FIGMA_TOKEN || null; // dev convenience only; GUI launches don't inherit shell env
}
function saveToken(t) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage isn’t available on this Mac.');
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(tokenFile(), safeStorage.encryptString(t), { mode: 0o600 });
}

// ---- IPC ----
let current = null; // { controller }

ipcMain.handle('token:status', () => ({ saved: !!loadToken() }));
ipcMain.handle('token:save', (_e, t) => {
  const token = String(t || '').trim();
  if (token.length < 10 || /\s/.test(token)) return { ok: false, message: 'That doesn’t look like a Figma token.' };
  try { saveToken(token); return { ok: true }; } catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('token:clear', () => { try { fs.rmSync(tokenFile(), { force: true }); } catch { /* ignore */ } return { ok: true }; });

ipcMain.handle('grab:start', async (e, url, opts) => {
  if (current) return { ok: false, error: { code: 'BUSY', message: 'Already running.' } };
  const controller = new AbortController();
  current = { controller };
  try {
    const result = await grab({
      url,
      token: loadToken(),
      outRoot: (fs.mkdirSync(outRoot(), { recursive: true }), outRoot()),
      fetch: net.fetch.bind(net),
      signal: controller.signal,
      split: opts?.split !== false,
      onProgress: (p) => { if (!e.sender.isDestroyed()) e.sender.send('grab:progress', p); },
    });
    await makeThumbs(result, (p) => { if (!e.sender.isDestroyed()) e.sender.send('grab:progress', p); });
    result.chunks = result.chunks.map((c) => ({
      ...c,
      image: c.png ? imageUrl(path.join(result.outDir, c.png)) : null,
      thumb: c.thumb ? imageUrl(path.join(result.outDir, c.thumb)) : null,
      thumbs: c.thumbs ? c.thumbs.map((t) => imageUrl(path.join(result.outDir, t))) : null,
    }));
    return { ok: true, result };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, cancelled: true };
    if (err instanceof GrabError) return { ok: false, error: { code: err.code, message: err.message, pages: err.pages } };
    console.error(err);
    return { ok: false, error: { code: 'UNKNOWN', message: 'Something went wrong. Please try again.' } };
  } finally {
    current = null;
  }
});
ipcMain.handle('grab:cancel', () => { current?.controller.abort(); return { ok: true }; });

ipcMain.handle('open:figma', (_e, url) => {
  if (/^https:\/\/(www\.)?figma\.com\//.test(String(url))) shell.openExternal(url);
});
ipcMain.handle('open:folder', (_e, dir) => {
  const abs = path.resolve(String(dir || ''));
  if (isInside(abs, outRoot())) shell.openPath(abs);
});

// ---- window ----
function createWindow() {
  const win = new BrowserWindow({
    width: 1020, height: 780, minWidth: 720, minHeight: 560,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151618' : '#f6f5f2',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (ev) => ev.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.env.FIGMA_GRAB_SMOKE) {
    win.webContents.on('did-finish-load', async () => {
      const h1 = await win.webContents.executeJavaScript(`document.querySelector('h1:not([hidden]), .view:not([hidden]) h1')?.textContent`);
      const api = await win.webContents.executeJavaScript(`typeof window.api?.start`);
      console.log('SMOKE', JSON.stringify({ h1, api }));
      app.quit();
    });
  }
}

// Headless mode for testing: FIGMA_GRAB_RUN=<figma link> [FIGMA_GRAB_OUT=<dir>] runs the same engine as the window
// using the saved token, prints a JSON summary (never the token), and quits.
async function headlessRun(url) {
  try {
    const out = process.env.FIGMA_GRAB_OUT || outRoot();
    fs.mkdirSync(out, { recursive: true });
    const result = await grab({
      url, token: loadToken(), outRoot: out, fetch: net.fetch.bind(net), split: process.env.FIGMA_GRAB_SPLIT !== '0',
      onProgress: (p) => console.log('PROGRESS ' + JSON.stringify({ label: p.label, pct: Math.round(p.pct || 0), done: p.done ?? null, total: p.total ?? null })),
    });
    await makeThumbs(result);
    console.log('RESULT ' + JSON.stringify({
      fileName: result.fileName, rootName: result.rootName, outDir: result.outDir,
      chunks: result.chunks.map((c) => ({ title: c.title, name: c.name, type: c.type, group: c.group, parent: c.parentId, w: c.width, h: c.height, scale: c.scale, small: c.small, png: !!c.png, thumb: !!c.thumb, strip: !!c.thumbs })),
    }));
  } catch (e) {
    console.log('ERROR ' + JSON.stringify({ code: e.code || 'UNKNOWN', message: e.message, pages: e.pages }));
  }
  app.quit();
}

app.whenReady().then(() => {
  if (process.env.FIGMA_GRAB_RUN) return headlessRun(process.env.FIGMA_GRAB_RUN);
  protocol.handle('grab', (req) => {
    const abs = path.resolve(decodeURIComponent(new URL(req.url).pathname));
    if (!isInside(abs, outRoot())) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(abs).toString());
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
