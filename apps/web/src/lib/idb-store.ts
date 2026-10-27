import type { LocalRow, LocalStore, OutboxEntry } from '@worko/sync';

/** Encrypts every stored value. Desktop: key from the OS keychain (Electron safeStorage). */
export type Cipher = { encrypt(plain: string): Promise<string>; decrypt(blob: string): Promise<string> };

export async function aesGcmCipher(rawKey: Uint8Array): Promise<Cipher> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(rawKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
  const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return {
    async encrypt(plain) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
      return `${b64(iv)}.${b64(ct)}`;
    },
    async decrypt(blob) {
      const [iv, ct] = blob.split('.') as [string, string];
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct)));
    },
  };
}
const plain: Cipher = { encrypt: async (s) => s, decrypt: async (s) => s };

const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/**
 * Offline store on IndexedDB for web and desktop. Keys (table/id, outbox seq) stay clear so they can be
 * indexed; all content is encrypted when a cipher is supplied.
 */
export class IdbStore implements LocalStore {
  private constructor(private db: IDBDatabase, private c: Cipher) {}

  static async open(name: string, cipher: Cipher = plain): Promise<IdbStore> {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore('rows', { keyPath: 'k' }).createIndex('table', 'table');
      db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }).createIndex('key', 'key', { unique: true });
      db.createObjectStore('meta', { keyPath: 'k' });
    };
    return new IdbStore(await req(open), cipher);
  }

  private tx(stores: string[], mode: IDBTransactionMode = 'readonly') { return this.db.transaction(stores, mode); }
  private done(t: IDBTransaction) { return new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }
  private async unpack(v: { data: string } | undefined): Promise<LocalRow | null> { return v ? JSON.parse(await this.c.decrypt(v.data)) : null; }

  async get(table: string, id: string) { return this.unpack(await req(this.tx(['rows']).objectStore('rows').get(`${table}:${id}`))); }

  async put(rows: LocalRow[]) {
    const packed = await Promise.all(rows.map(async (r) => ({ k: `${r.table}:${r.id}`, table: r.table, data: await this.c.encrypt(JSON.stringify(r)) })));
    const t = this.tx(['rows'], 'readwrite');
    for (const p of packed) t.objectStore('rows').put(p);
    await this.done(t);
  }

  async remove(table: string, id: string) { const t = this.tx(['rows'], 'readwrite'); t.objectStore('rows').delete(`${table}:${id}`); await this.done(t); }

  async list(table: string) {
    const all = await req(this.tx(['rows']).objectStore('rows').index('table').getAll(table));
    return (await Promise.all(all.map((v) => this.unpack(v)))).filter((r): r is LocalRow => !!r && !r.deleted);
  }

  async outboxAdd(e: OutboxEntry) {
    const data = await this.c.encrypt(JSON.stringify(e));
    const t = this.tx(['outbox'], 'readwrite'); t.objectStore('outbox').add({ key: e.key, data }); await this.done(t);
  }

  async outboxList(n: number) {
    const all = await req(this.tx(['outbox']).objectStore('outbox').getAll(undefined, n));
    return Promise.all(all.map(async (v: { data: string }) => JSON.parse(await this.c.decrypt(v.data)) as OutboxEntry));
  }

  async outboxRemove(keys: string[]) {
    const t = this.tx(['outbox'], 'readwrite'); const idx = t.objectStore('outbox').index('key');
    for (const k of keys) { const r = idx.getKey(k); r.onsuccess = () => { if (r.result !== undefined) t.objectStore('outbox').delete(r.result); }; }
    await this.done(t);
  }

  async outboxCount() { return req(this.tx(['outbox']).objectStore('outbox').count()); }

  async getMeta(k: string) {
    const v = await req(this.tx(['meta']).objectStore('meta').get(k)) as { data: string } | undefined;
    return v ? this.c.decrypt(v.data) : null;
  }
  async setMeta(k: string, v: string) { const data = await this.c.encrypt(v); const t = this.tx(['meta'], 'readwrite'); t.objectStore('meta').put({ k, data }); await this.done(t); }

  async wipe() {
    const t = this.tx(['rows', 'outbox', 'meta'], 'readwrite');
    for (const s of ['rows', 'outbox', 'meta']) t.objectStore(s).clear();
    await this.done(t);
  }

  close() { this.db.close(); }
}
