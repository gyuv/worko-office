import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { aesGcmCipher, IdbStore } from './idb-store';

describe('IdbStore', () => {
  it('stores rows, outbox and meta; encrypts content at rest; wipes', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const s = await IdbStore.open('t1', await aesGcmCipher(key));
    await s.put([{ table: 'notification', id: 'n1', version: 2, deleted: false, fields: { title: 'Hearing for ABC Pvt Ltd' } }]);
    await s.outboxAdd({ key: 'k1', table: 'notification', id: 'n1', baseVersion: 2, patch: { read_at: 'x' } });
    await s.outboxAdd({ key: 'k2', table: 'notification', id: 'n1', baseVersion: 2, patch: { acked_at: 'y' } });
    await s.setMeta('cursor', '17');
    expect((await s.get('notification', 'n1'))?.fields.title).toBe('Hearing for ABC Pvt Ltd');
    expect((await s.outboxList(10)).map((e) => e.key)).toEqual(['k1', 'k2']);
    await s.outboxRemove(['k1']);
    expect(await s.outboxCount()).toBe(1);
    expect(await s.getMeta('cursor')).toBe('17');

    // Raw IndexedDB contents never contain the plaintext.
    const raw = await new Promise<unknown[]>((res) => {
      const r = indexedDB.open('t1'); r.onsuccess = () => { const g = r.result.transaction('rows').objectStore('rows').getAll(); g.onsuccess = () => res(g.result); };
    });
    expect(JSON.stringify(raw)).not.toContain('ABC Pvt');

    // A different key cannot read it.
    s.close();
    const wrong = await IdbStore.open('t1', await aesGcmCipher(crypto.getRandomValues(new Uint8Array(32))));
    await expect(wrong.get('notification', 'n1')).rejects.toBeTruthy();
    wrong.close();

    const again = await IdbStore.open('t1', await aesGcmCipher(key));
    await again.wipe();
    expect(await again.list('notification')).toEqual([]);
    expect(await again.outboxCount()).toBe(0);
  });
});
