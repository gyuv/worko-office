import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '../lib/session';
import { App } from './App';

const tokens = { accessToken: 'a', refreshToken: 'r', expiresIn: 900, sessionId: 's1', userId: 'u1', tenantId: 't1' };
const me = (roles: string[], grants: Array<{ module: string; action: string; scope: string }>) =>
  ({ id: 'u1', name: 'Anita Sharma', email: 'a@x.in', firmName: 'Sharma & Co', firmSlug: 'sharma', roles, grants, totpEnabled: false });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let routes: Record<string, (body: unknown) => Response>;
beforeEach(() => {
  localStorage.clear();
  location.hash = '';
  useSession.setState({ tokens: null, ready: false, notice: null });
  routes = {};
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/v1/, '');
    const body = req.method === 'POST' ? await req.clone().json().catch(() => undefined) : undefined;
    return (routes[`${req.method} ${path}`] ?? (() => json(404, { message: 'nf' })))(body);
  }));
});

describe('login', () => {
  it('asks for the authenticator code when MFA is required, then signs in', async () => {
    const calls: unknown[] = [];
    routes['POST /auth/login'] = (b) => { calls.push(b); return (b as { totp?: string }).totp ? json(200, tokens) : json(401, { statusCode: 401, code: 'MFA_REQUIRED', message: 'x' }); };
    routes['GET /me'] = () => json(200, me(['partner'], []));
    render(<App />);
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Firm ID'), 'sharma');
    await u.type(screen.getByLabelText('Email'), 'a@x.in');
    await u.type(screen.getByLabelText('Password'), 'pw');
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('6-digit code');
    await u.type(screen.getByLabelText('Authenticator code'), '123456');
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: /Anita/ })).toBeInTheDocument();
    expect(calls[1]).toMatchObject({ firm: 'sharma', totp: '123456', device: { platform: 'web' } });
    expect(JSON.parse(localStorage.getItem('worko.session')!)).toMatchObject({ sessionId: 's1' });
  });

  it('shows a generic message for bad credentials and lockout', async () => {
    routes['POST /auth/login'] = () => json(429, { statusCode: 429, message: 'locked' });
    render(<App />);
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Firm ID'), 'f');
    await u.type(screen.getByLabelText('Email'), 'a@x.in');
    await u.type(screen.getByLabelText('Password'), 'pw');
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts');
  });
});

describe('signed-in shell', () => {
  beforeEach(() => localStorage.setItem('worko.session', JSON.stringify(tokens)));

  it('hides modules the user lacks permission for', async () => {
    routes['GET /me'] = () => json(200, me(['article'], [{ module: 'tasks', action: 'view', scope: 'own' }]));
    render(<App />);
    await screen.findByRole('heading', { name: /Anita/ });
    expect(screen.queryAllByRole('link', { name: 'Audit log' })).toHaveLength(0);
    expect(screen.queryAllByRole('link', { name: 'Team' })).toHaveLength(0);
  });

  it('Ctrl+K opens the palette and navigates', async () => {
    routes['GET /me'] = () => json(200, me(['partner'], [{ module: 'audit_log', action: 'view', scope: 'all' }]));
    routes['GET /audit'] = () => json(200, [{ seq: '1', at: '2026-10-27T05:00:00Z', action: 'auth.login', entity: 'device_session', actorName: 'Anita Sharma' }]);
    render(<App />);
    await screen.findByRole('heading', { name: /Anita/ });
    const u = userEvent.setup();
    await u.keyboard('{Control>}k{/Control}');
    await u.type(screen.getByRole('combobox'), 'audit');
    await u.keyboard('{Enter}');
    expect(await screen.findByText('auth.login')).toBeInTheDocument();
    expect(location.hash).toBe('#/audit');
  });

  it('remote wipe returns to login with an explanation and clears storage', async () => {
    routes['GET /me'] = () => json(401, { statusCode: 401, code: 'DEVICE_WIPE', message: 'wipe' });
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('signed out remotely');
    await waitFor(() => expect(localStorage.getItem('worko.session')).toBeNull());
  });
});

describe('offline banner', () => {
  it('appears when the browser goes offline', async () => {
    localStorage.setItem('worko.session', JSON.stringify(tokens));
    routes['GET /me'] = () => json(200, me(['partner'], []));
    render(<App />);
    await screen.findByRole('heading', { name: /Anita/ });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => { dispatchEvent(new Event('offline')); });
    expect(screen.getByRole('status')).toHaveTextContent('offline');
  });
});
