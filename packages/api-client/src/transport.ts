import { OfflineError, type OutboxEntry, type PullPage, type PushResult, type Transport } from '@worko/sync';
import type { WorkoClient } from './index.js';

/** Adapts the typed API client to the sync engine. Network failures and 5xx become OfflineError (retry later). */
export function createHttpTransport(api: WorkoClient): Transport {
  const call = async <T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> => {
    let r;
    try { r = await p; } catch (e) { throw new OfflineError(e); }
    if (r.response.status >= 500 || r.response.status === 0) throw new OfflineError(r.response.status);
    if (!r.response.ok || r.data === undefined) throw new Error(`sync request failed: HTTP ${r.response.status}`);
    return r.data;
  };
  return {
    async push(mutations: OutboxEntry[]): Promise<PushResult[]> {
      return (await call(api.POST('/sync/push', { body: { mutations } }))).results as PushResult[];
    },
    async pull(since: number, limit: number): Promise<PullPage> {
      return call(api.GET('/sync/pull', { params: { query: { since, limit } } })) as Promise<PullPage>;
    },
  };
}
