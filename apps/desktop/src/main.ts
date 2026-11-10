import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, Notification, protocol, safeStorage, session, shell, Tray, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { readFile } from 'node:fs/promises';
import { APP_ORIGIN, DEFAULTS, deepLinkHash, isAllowedExternal, isAppUrl, isTokenPair, loadSettings, normaliseServer, saveSettings, withApiInCsp } from './settings';
import { randomBytes } from 'node:crypto';
import { DbKeyStore, TokenStore } from './token-store';
import { trayMenu } from './tray-menu';
import { spawn } from 'node:child_process';
import { platformKey, Updater, type UpdateState } from './updater';

const userData = () => app.getPath('userData');
const settingsFile = () => join(userData(), 'settings.json');
let settings = { ...DEFAULTS }; // loaded from disk once the app is ready

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let badge = 0;
let quitting = false;
// The renderer is served from app://worko/ (not file://) so API requests carry a real Origin the server can allow.
const webDir = normalize(join(__dirname, '../../web/dist'));
const appUrl = process.env.WORKO_WEB_URL ?? `${APP_ORIGIN}/index.html`;
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
function serveApp() {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
    const file = normalize(join(webDir, rel));
    if (u.host !== 'worko' || (file !== webDir && !file.startsWith(webDir + sep))) return new Response('Not found', { status: 404 });
    if (rel === '/index.html') {
      // The CSP's connect-src must include the server this install talks to (it can be changed at sign-in).
      const html = withApiInCsp(await readFile(file, 'utf8'), settings.apiBase);
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}
const tokens = new TokenStore(join(app.getPath('userData'), 'session.bin'), safeStorage);
const dbKey = new DbKeyStore(join(app.getPath('userData'), 'dbkey.bin'), safeStorage, randomBytes);

if (!app.requestSingleInstanceLock()) app.quit();
// worko:// deep links: Windows/Linux deliver them in argv (first start or second instance), macOS via open-url.
app.setAsDefaultProtocolClient('worko');
let pendingLink: string | null = process.argv.find((a) => a.startsWith('worko://')) ?? null;
function openDeepLink(url: string) {
  const hash = deepLinkHash(url);
  if (!hash) return;
  if (!win) { pendingLink = url; return; }
  showWindow();
  void win.loadURL(`${appUrl.split('#')[0]}${hash}`);
}
app.on('second-instance', (_e, argv) => { const link = argv.find((a) => a.startsWith('worko://')); if (link) openDeepLink(link); else showWindow(); });
app.on('open-url', (e, url) => { e.preventDefault(); openDeepLink(url); });
app.setAppUserModelId('in.worko.desktop'); // required for Windows toasts

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600, show: !settings.startMinimised, title: 'Worko',
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  win.removeMenu();
  void win.loadURL(appUrl);
  // Closing hides to tray so reminders keep firing; Quit from the tray exits.
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win?.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (isAllowedExternal(url, settings.apiBase)) void shell.openExternal(url); return { action: 'deny' }; });
  // Only the app's own page may ever load in this window (it carries the privileged preload bridge).
  const guard = (e: { preventDefault(): void }, url: string) => { if (!isAppUrl(url, appUrl)) e.preventDefault(); };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
}

function showWindow() {
  if (!win) createWindow();
  win!.show(); win!.focus();
}

function refreshTray() {
  tray?.setToolTip(badge ? `Worko — ${badge} pending` : 'Worko');
  tray?.setContextMenu(Menu.buildFromTemplate(trayMenu({
    badge, autoStart: settings.autoStart, open: showWindow, quit: () => { quitting = true; app.quit(); },
    toggleAutoStart: () => { settings.autoStart = !settings.autoStart; applyAutoStart(); saveSettings(settingsFile(), settings); refreshTray(); },
  })));
}

function applyAutoStart() {
  app.setLoginItemSettings({ openAtLogin: settings.autoStart, args: ['--hidden'] });
}

app.whenReady().then(() => {
  settings = loadSettings(settingsFile());
  if (process.env.WORKO_API_BASE) settings.apiBase = process.env.WORKO_API_BASE;
  if (process.argv.includes('--hidden')) settings.startMinimised = true;
  serveApp();
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'notifications'));
  applyAutoStart();
  createWindow();
  if (pendingLink) { const l = pendingLink; pendingLink = null; openDeepLink(l); }
  tray = new Tray(nativeImage.createEmpty()); // VERIFY: branded .ico/.png tray icons land with installer assets (Phase 12)
  tray.on('click', showWindow);
  refreshTray();
  startUpdater();
});

/** In-app updates: check GitHub Releases at every start (and every 4 h), download + verify in the background. */
let updater: Updater | null = null;
function startUpdater() {
  const platform = platformKey(process.platform, process.arch);
  if (!platform || (!app.isPackaged && !process.env.WORKO_FORCE_UPDATER)) return;
  updater = new Updater({
    current: app.getVersion(), platform, dir: join(app.getPath('temp'), 'worko-updates'), fetch: globalThis.fetch.bind(globalThis),
    onState: (st: UpdateState) => {
      win?.webContents.send('worko:update', st);
      if (st.phase === 'ready' && Notification.isSupported()) {
        const n = new Notification({ title: `Worko ${st.info.version} is ready`, body: 'Restart to update — it takes a few seconds.' });
        n.on('click', showWindow); n.show();
      }
    },
  });
  setTimeout(() => void updater?.check(), 4000);
  setInterval(() => void updater?.check(), 4 * 3600_000);
}
function installUpdate() {
  const st = updater?.state;
  if (!st || st.phase !== 'ready') return false;
  if (process.platform === 'win32') {
    // NSIS (electron-builder): silent install, then relaunch the new version.
    spawn(st.file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    quitting = true; setTimeout(() => app.quit(), 300);
  } else if (process.platform === 'darwin') {
    void shell.openPath(st.file); // unsigned builds cannot self-replace: open the dmg, the user drags Worko to Applications
  } else {
    void shell.openExternal(st.info.page);
  }
  return true;
}
app.on('window-all-closed', () => { /* stay resident in the tray */ });
app.on('before-quit', () => { quitting = true; });

/** Every IPC message must come from the app's own top-level page. */
const trusted = (e: IpcMainEvent | IpcMainInvokeEvent) => !!e.senderFrame && e.senderFrame === e.sender.mainFrame && isAppUrl(e.senderFrame.url, appUrl);
const handle = (ch: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) =>
  ipcMain.handle(ch, (e, ...a) => { if (!trusted(e)) throw new Error('Untrusted sender'); return fn(e, ...a); });
const on = (ch: string, fn: (e: IpcMainEvent, ...a: unknown[]) => void) =>
  ipcMain.on(ch, (e, ...a) => { if (trusted(e)) fn(e, ...a); else e.returnValue = null; });

on('worko:apiBase', (e) => { e.returnValue = settings.apiBase; });
handle('worko:apiBase:set', (_e, raw) => {
  const next = raw === null ? DEFAULTS.apiBase : normaliseServer(String(raw));
  if (!next) return false;
  settings.apiBase = next; saveSettings(settingsFile(), settings);
  setTimeout(() => win?.reload(), 50); // preload re-reads the address; CSP is rebuilt for the new server
  return true;
});
handle('worko:tokens:get', () => tokens.get());
handle('worko:tokens:set', (_e, t) => { if (!isTokenPair(t)) throw new Error('Invalid token payload'); tokens.set(t); });
handle('worko:settings:get', () => ({ autoStart: settings.autoStart }));
handle('worko:settings:set', (_e, s) => { settings.autoStart = !!(s as { autoStart?: unknown })?.autoStart; applyAutoStart(); saveSettings(settingsFile(), settings); refreshTray(); });
on('worko:badge', (_e, count) => { badge = Math.max(0, Math.min(9999, Number(count) || 0)); app.setBadgeCount(badge); refreshTray(); });
on('worko:notify', (_e, raw) => {
  const n = (raw ?? {}) as { title?: unknown; body?: unknown };
  if (!Notification.isSupported()) return;
  const toast = new Notification({ title: String(n.title).slice(0, 120), body: String(n.body).slice(0, 400) });
  toast.on('click', showWindow);
  toast.show();
});
handle('worko:update:get', () => updater?.state ?? { phase: 'idle', current: app.getVersion() });
handle('worko:update:check', () => updater?.check() ?? { phase: 'idle', current: app.getVersion() });
handle('worko:update:install', () => installUpdate());
/** Remote wipe: erase every local trace (tokens, cache, storage, future SQLite store) and restart clean. */
handle('worko:dbkey', () => new Uint8Array(dbKey.get()));
handle('worko:wipe', async () => {
  tokens.set(null);
  dbKey.destroy();
  await session.defaultSession.clearStorageData();
  await session.defaultSession.clearCache();
  rmSync(join(userData(), 'data'), { recursive: true, force: true });
});
