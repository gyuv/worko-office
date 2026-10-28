import type { RegisterKind } from './registers';

/** Signatures captured offline (or before the entry reached the server), waiting to upload. */
export type PendingSig = { kind: RegisterKind; entryId: string; uri: string; attempts: number; addedAt: string; lastError?: string };
export const MAX_ATTEMPTS = 20;

export function parseQueue(raw: string | null): PendingSig[] {
  try { const v: unknown = JSON.parse(raw ?? '[]'); return Array.isArray(v) ? v.filter((x): x is PendingSig => !!x && typeof x.entryId === 'string' && typeof x.uri === 'string') : []; }
  catch { return []; }
}
/** Re-signing the same entry replaces the earlier pending capture. */
export const enqueue = (q: PendingSig[], s: Omit<PendingSig, 'attempts' | 'addedAt'>, now = new Date()): PendingSig[] =>
  [...q.filter((x) => !(x.entryId === s.entryId && x.kind === s.kind)), { ...s, attempts: 0, addedAt: now.toISOString() }];
export const removeSig = (q: PendingSig[], kind: RegisterKind, entryId: string) => q.filter((x) => !(x.entryId === entryId && x.kind === kind));

export type UploadOutcome = 'ok' | 'not_synced' | 'offline' | 'failed';
/**
 * Try every pending item. 'ok' removes it; 'not_synced'/'offline' keep it untouched (expected states);
 * 'failed' counts an attempt and drops it after MAX_ATTEMPTS.
 */
export async function processQueue(q: PendingSig[], upload: (s: PendingSig) => Promise<UploadOutcome>): Promise<{ queue: PendingSig[]; uploaded: PendingSig[] }> {
  const queue: PendingSig[] = []; const uploaded: PendingSig[] = [];
  for (const s of q) {
    let r: UploadOutcome;
    try { r = await upload(s); } catch { r = 'failed'; }
    if (r === 'ok') uploaded.push(s);
    else if (r === 'failed') { if (s.attempts + 1 < MAX_ATTEMPTS) queue.push({ ...s, attempts: s.attempts + 1, lastError: r }); }
    else queue.push(s);
  }
  return { queue, uploaded };
}
