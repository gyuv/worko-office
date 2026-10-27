import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '../lib/session';
import { stopSync } from '../lib/sync';
import { App } from './App';

const tokens = { accessToken: 'a', refreshToken: 'r', expiresIn: 900, sessionId: 's1', userId: 'u1', tenantId: 't1' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notif = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  table: 'notification', id, version: 1, cursor: 1, deleted: false,
  fields: { user_id: 'u1', category: 'task.overdue', priority: 'high', title, body: 'ABC Pvt Ltd', fire_at: '2026-10-27T05:00:00.000Z', read_at: null, acked_at: null, snoozed_until: null, requires_ack: false, escalation_level: 0, ...extra },
});

class NoopWs { readyState = 0; onopen = null; onmessage = null; onclose = null; onerror = null; send() {} close() {} }

let pushes: unknown[];
beforeEach(async () => {
  await stopSync(false);
  localStorage.clear(); location.hash = '#/home';
  localStorage.setItem('worko.session', JSON.stringify(tokens));
  useSession.setState({ tokens: null, ready: false, notice: null });
  pushes = [];
  vi.stubGlobal('WebSocket', NoopWs);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname.replace(/^\/v1/, '');
    if (path === '/me') return json(200, { id: 'u1', name: 'Anita Sharma', email: 'a@x.in', firmName: 'F', firmSlug: 'f', roles: ['partner'], grants: [], totpEnabled: false });
    if (path === '/sync/pull') {
      const since = Number(new URL(req.url).searchParams.get('since'));
      return json(200, since ? { changes: [], cursor: since, hasMore: false } : { changes: [notif('n1', 'GSTR-3B overdue'), notif('n2', 'Hearing tomorrow', { requires_ack: true, priority: 'critical', escalation_level: 1 })], cursor: 2, hasMore: false });
    }
    if (path === '/sync/push') {
      const b = await req.json() as { mutations: Array<{ key: string }> };
      pushes.push(...b.mutations);
      return json(200, { results: b.mutations.map((m) => ({ key: m.key, status: 'applied', version: 2 })) });
    }
    return json(404, { message: 'nf' });
  }));
});

describe('notification inbox (synced)', () => {
  it('shows pulled notifications with an unread badge, and marking read syncs through the outbox', async () => {
    render(<App />);
    const bell = await screen.findByRole('button', { name: /Notifications, 2 unread/ });
    expect(document.title).toBe('(2) Worko');
    await userEvent.click(bell);
    expect(await screen.findByText('GSTR-3B overdue')).toBeInTheDocument();
    expect(screen.getByText(/Needs acknowledgement/)).toBeInTheDocument();
    expect(screen.getByText(/Escalated \(level 1\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(pushes).toEqual([expect.objectContaining({ table: 'notification', id: 'n1', baseVersion: 1, patch: { read_at: expect.any(String) } })]));
    await userEvent.click(screen.getByRole('button', { name: /Acknowledge/ }));
    await waitFor(() => expect(pushes).toHaveLength(2));
    expect(pushes[1]).toMatchObject({ id: 'n2', patch: { acked_at: expect.any(String), read_at: expect.any(String) } });
    await screen.findByRole('button', { name: 'Notifications' });
    expect(document.title).toBe('Worko');
  });

  it('shows sync status', async () => {
    render(<App />);
    expect(await screen.findByRole('button', { name: /^Synced/ })).toBeInTheDocument();
  });
});
