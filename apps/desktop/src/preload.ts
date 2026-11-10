import { contextBridge, ipcRenderer } from 'electron';

/** The renderer's only door to the OS. Mirrors `DesktopBridge` in apps/web/src/lib/platform.ts. */
const apiBase = ipcRenderer.sendSync('worko:apiBase') as string;
contextBridge.exposeInMainWorld('worko', {
  platform: 'desktop',
  apiBase,
  setApiBase: (url: string | null) => ipcRenderer.invoke('worko:apiBase:set', url),
  tokens: {
    get: () => ipcRenderer.invoke('worko:tokens:get'),
    set: (t: unknown) => ipcRenderer.invoke('worko:tokens:set', t),
  },
  notify: (n: { title: string; body: string; id?: string }) => ipcRenderer.send('worko:notify', n),
  setBadge: (count: number) => ipcRenderer.send('worko:badge', count),
  wipeLocalData: () => ipcRenderer.invoke('worko:wipe'),
  getDbKey: () => ipcRenderer.invoke('worko:dbkey'),
  updates: {
    get: () => ipcRenderer.invoke('worko:update:get'),
    check: () => ipcRenderer.invoke('worko:update:check'),
    install: () => ipcRenderer.invoke('worko:update:install'),
    onState: (cb: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on('worko:update', h);
      return () => { ipcRenderer.removeListener('worko:update', h); };
    },
  },
  settings: {
    get: () => ipcRenderer.invoke('worko:settings:get'),
    set: (s: { autoStart: boolean }) => ipcRenderer.invoke('worko:settings:set', s),
  },
});
