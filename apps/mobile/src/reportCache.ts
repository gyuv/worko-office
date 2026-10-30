import * as FileSystem from 'expo-file-system';
import { Linking } from 'react-native';
import { cacheFileName, exportDownloadPath, makeDashCache, readDashCache, safeFileName, tokenDownloadPath, type DashCache, type DashboardData } from './logic/reports';
import { api, apiBase, useSession } from './session';

/** Phase 11 (D170): the last default-dashboard response, per tenant × user, in app-private files. Wiped on logout / remote wipe. */
const DIR = `${FileSystem.documentDirectory ?? ''}reports-cache/`;

export async function saveDashCache(owner: string, data: DashboardData): Promise<void> {
  if (!owner || !FileSystem.documentDirectory) return;
  try {
    await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => undefined);
    await FileSystem.writeAsStringAsync(DIR + cacheFileName(owner), JSON.stringify(makeDashCache(owner, data, Date.now())));
  } catch { /* best effort */ }
}
export async function loadDashCache(owner: string): Promise<DashCache | null> {
  if (!owner || !FileSystem.documentDirectory) return null;
  try { return readDashCache(await FileSystem.readAsStringAsync(DIR + cacheFileName(owner)), owner); } catch { return null; }
}
export async function clearReportCache(): Promise<void> {
  if (!FileSystem.documentDirectory) return;
  await FileSystem.deleteAsync(DIR, { idempotent: true }).catch(() => undefined);
}

/** Recipient-bound scheduled-report file (D166): bearer download into the cache dir, then hand to a viewer via content:// URI. */
export const openReportDownload = (token: string) => openReportFile(tokenDownloadPath(token), token.slice(0, 8));
/** `report.ready` notice → download by export id (re-rendered for the caller's current access). */
export const openReportExport = (id: string) => openReportFile(exportDownloadPath(id), id.slice(0, 8));

async function openReportFile(path: string, tag: string): Promise<void> {
  const url = apiBase.replace(/\/$/, '') + path;
  const target = `${FileSystem.cacheDirectory ?? ''}${safeFileName(`report-${tag}`)}`;
  const get = () => FileSystem.downloadAsync(url, target, { headers: { Authorization: 'Bearer ' + (useSession.getState().tokens?.accessToken ?? '') } });
  let res = await get();
  if (res.status === 401) { await api.GET('/me').catch(() => undefined); res = await get(); }
  if (res.status !== 200) {
    const code = await errorCode(res.uri, res.status);
    await FileSystem.deleteAsync(res.uri, { idempotent: true }).catch(() => undefined);
    throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, code });
  }
  const cd = res.headers['Content-Disposition'] ?? res.headers['content-disposition'] ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1];
  let uri = res.uri;
  if (name) { const named = `${FileSystem.cacheDirectory ?? ''}${safeFileName(name)}`; await FileSystem.moveAsync({ from: res.uri, to: named }).then(() => { uri = named; }).catch(() => undefined); }
  await Linking.openURL(await FileSystem.getContentUriAsync(uri));
}

/** The error JSON body the server wrote into the target file (e.g. source_gone, export_forbidden); falls back by status. */
async function errorCode(uri: string, status: number): Promise<string | undefined> {
  try { const c = (JSON.parse(await FileSystem.readAsStringAsync(uri)) as { code?: unknown }).code; if (typeof c === 'string') return c; } catch { /* not JSON */ }
  return status === 410 ? 'link_expired' : undefined;
}
