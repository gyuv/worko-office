import { contextBridge, ipcRenderer } from 'electron';

/** The renderer's only door to the OS. Mirrors `DesktopBridge` in apps/web/src/lib/platform.ts. */
const apiBase = ipcRenderer.sendSync('worko:apiBase') as string;
contextBridge.exposeInMainWorld('worko', {
  platform: 'desktop',
  apiBase,
  tokens: {
    get: () => ipcRenderer.invoke('worko:tokens:get'),
    set: (t: unknown) => ipcRenderer.invoke('worko:tokens:set', t),
  },
  notify: (n: { title: string; body: string; id?: string }) => ipcRenderer.send('worko:notify', n),
  setBadge: (count: number) => ipcRenderer.send('worko:badge', count),
  wipeLocalData: () => ipcRenderer.invoke('worko:wipe'),
  settings: {
    get: () => ipcRenderer.invoke('worko:settings:get'),
    set: (s: { autoStart: boolean }) => ipcRenderer.invoke('worko:settings:set', s),
  },
});
