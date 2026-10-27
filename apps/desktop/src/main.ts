import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, safeStorage, session, shell, Tray } from 'electron';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS, isAllowedExternal, loadSettings, saveSettings } from './settings';
import { TokenStore } from './token-store';
import { trayMenu } from './tray-menu';

const userData = () => app.getPath('userData');
const settingsFile = () => join(userData(), 'settings.json');
let settings = { ...DEFAULTS }; // loaded from disk once the app is ready

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let badge = 0;
let quitting = false;
const tokens = new TokenStore(join(app.getPath('userData'), 'session.bin'), safeStorage);

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());
app.setAppUserModelId('in.worko.desktop'); // required for Windows toasts

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600, show: !settings.startMinimised, title: 'Worko',
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  win.removeMenu();
  const devUrl = process.env.WORKO_WEB_URL;
  if (devUrl) void win.loadURL(devUrl); else void win.loadFile(join(__dirname, '../../web/dist/index.html'));
  // Closing hides to tray so reminders keep firing; Quit from the tray exits.
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win?.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (isAllowedExternal(url, settings.apiBase)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://') && url !== devUrl) e.preventDefault(); });
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
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'notifications'));
  applyAutoStart();
  createWindow();
  tray = new Tray(nativeImage.createEmpty()); // VERIFY: branded .ico/.png tray icons land with installer assets (Phase 12)
  tray.on('click', showWindow);
  refreshTray();
});
app.on('window-all-closed', () => { /* stay resident in the tray */ });
app.on('before-quit', () => { quitting = true; });

ipcMain.on('worko:apiBase', (e) => { e.returnValue = settings.apiBase; });
ipcMain.handle('worko:tokens:get', () => tokens.get());
ipcMain.handle('worko:tokens:set', (_e, t: unknown) => tokens.set(t));
ipcMain.handle('worko:settings:get', () => ({ autoStart: settings.autoStart }));
ipcMain.handle('worko:settings:set', (_e, s: { autoStart: boolean }) => { settings.autoStart = !!s.autoStart; applyAutoStart(); saveSettings(settingsFile(), settings); refreshTray(); });
ipcMain.on('worko:badge', (_e, count: number) => { badge = Math.max(0, Number(count) || 0); app.setBadgeCount(badge); refreshTray(); });
ipcMain.on('worko:notify', (_e, n: { title: string; body: string }) => {
  if (!Notification.isSupported()) return;
  const toast = new Notification({ title: String(n.title).slice(0, 120), body: String(n.body).slice(0, 400) });
  toast.on('click', showWindow);
  toast.show();
});
/** Remote wipe: erase every local trace (tokens, cache, storage, future SQLite store) and restart clean. */
ipcMain.handle('worko:wipe', async () => {
  tokens.set(null);
  await session.defaultSession.clearStorageData();
  await session.defaultSession.clearCache();
  rmSync(join(userData(), 'data'), { recursive: true, force: true });
});
