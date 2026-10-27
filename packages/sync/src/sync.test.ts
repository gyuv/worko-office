import { describe, expect, it } from 'vitest';
import { SyncClient, SyncServer } from './index.js';

/** Deterministic PRNG so failures are reproducible by seed. */
function rng(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function simulate(seed: number) {
  const r = rng(seed);
  const server = new SyncServer();
  const clients = ['web', 'desk', 'android'].map((d) => new SyncClient(d));
  const online = clients.map(() => true);
  for (let step = 0; step < 400; step++) {
    const i = Math.floor(r() * clients.length); const c = clients[i]!;
    const op = r();
    if (op < 0.45) c.write('task', `t${Math.floor(r() * 8)}`, { [['title', 'stage', 'owner'][Math.floor(r() * 3)]!]: `${c.deviceId}-${step}` }, r() < 0.03);
    else if (op < 0.6) online[i] = !online[i];
    else if (online[i]) {
      // Random batch sizes, duplicate re-deliveries and dropped acks.
      c.push((m) => { if (r() < 0.1) return null; const res = server.apply(m); if (r() < 0.2) server.apply(m); return res; }, 1 + Math.floor(r() * 5));
      let p; do { p = server.pull(c.cursor, undefined, 1 + Math.floor(r() * 4)); c.ingest(p); } while (p.upserts.length);
    }
  }
  // Heal: everyone online, drain outboxes, pull.
  for (let k = 0; k < 3; k++) for (const c of clients) { while (c.outbox.length) c.push((m) => server.apply(m)); let p; do { p = server.pull(c.cursor); c.ingest(p); } while (p.upserts.length); }
  return { server, clients };
}

describe('sync convergence (property-based simulator)', () => {
  for (let seed = 1; seed <= 50; seed++) {
    it(`seed ${seed} converges`, () => {
      const { server, clients } = simulate(seed);
      const s = server.snapshot();
      for (const c of clients) expect(c.snapshot()).toEqual(s);
    });
  }
});

describe('sync semantics', () => {
  it('idempotent duplicate delivery', () => {
    const s = new SyncServer(); const c = new SyncClient('d');
    c.write('task', 'a', { title: 'x' });
    const m = c.outbox[0]!;
    expect(s.apply(m).status).toBe('applied');
    expect(s.apply(m).status).toBe('duplicate');
    expect(s.cursor).toBe(1);
  });
  it('records conflict losers for review', () => {
    const s = new SyncServer(); const a = new SyncClient('a'); const b = new SyncClient('b');
    a.write('task', 't', { stage: 'Prepare' }); a.push((m) => s.apply(m));
    a.ingest(s.pull(0)); b.ingest(s.pull(0));
    a.write('task', 't', { stage: 'Check' }); b.write('task', 't', { stage: 'File' });
    a.push((m) => s.apply(m)); b.push((m) => s.apply(m));
    expect(s.conflicts).toMatchObject([{ field: 'stage', lost: 'Check', kept: 'File' }]);
  });
  it('field-level merge keeps non-conflicting edits', () => {
    const s = new SyncServer(); const a = new SyncClient('a'); const b = new SyncClient('b');
    a.write('task', 't', { title: 'T', stage: 'S' }); a.push((m) => s.apply(m)); b.ingest(s.pull(0)); a.ingest(s.pull(0));
    a.write('task', 't', { title: 'T2' }); b.write('task', 't', { stage: 'S2' });
    a.push((m) => s.apply(m)); b.push((m) => s.apply(m));
    expect(s.snapshot().get('task:t')?.fields).toEqual({ title: 'T2', stage: 'S2' });
    expect(s.conflicts).toHaveLength(0);
  });
  it('strict tables reject stale writes (money/legal records)', () => {
    const s = new SyncServer(new Set(['invoice'])); const a = new SyncClient('a'); const b = new SyncClient('b');
    a.write('invoice', 'i', { total: 100 }); a.push((m) => s.apply(m)); a.ingest(s.pull(0)); b.ingest(s.pull(0));
    a.write('invoice', 'i', { total: 200 }); b.write('invoice', 'i', { total: 300 });
    expect(a.push((m) => s.apply(m))[0]?.status).toBe('applied');
    expect(b.push((m) => s.apply(m))[0]?.status).toBe('rejected_stale');
  });
  it('revoked access purges local rows', () => {
    const s = new SyncServer(); const a = new SyncClient('a'); const b = new SyncClient('b');
    a.write('client', 'secret', { name: 'X' }); a.push((m) => s.apply(m)); b.ingest(s.pull(0));
    expect(b.rows.has('client:secret')).toBe(true);
    a.write('client', 'secret', { sensitive: true }); a.push((m) => s.apply(m));
    b.ingest(s.pull(b.cursor, (r) => !r.fields.sensitive));
    expect(b.rows.has('client:secret')).toBe(false);
  });
});
