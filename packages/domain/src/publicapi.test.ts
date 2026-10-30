import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  classifyAddress, decodeCursor, encodeCursor, ipLiteralOf, isBlockedAddress, keyActor, keyGrants, keyIpAllowed, parseApiKey, parseIpv4Loose,
  passwordIssues, scopesNotHeld, signatureHeader, signedContent, verifyWebhookSignature, webhookBackoffMs, webhookEnvelope, WindowLimiter, can,
  type Role,
} from './index.js';

const G1 = '11111111-1111-4111-8111-111111111111', G2 = '22222222-2222-4222-8222-222222222222';
const roles: Role[] = [
  { key: 'a', name: 'A', system: false, grants: [{ module: 'clients', action: 'view', scope: 'all' }, { module: 'tasks', action: 'view', scope: 'team' }, { module: 'billing', action: 'view', scope: 'groups', clientGroupIds: [G1] }, { module: 'tasks', action: 'edit', scope: 'own' }], hiddenFields: ['client.fees'] },
  { key: 'b', name: 'B', system: false, grants: [{ module: 'tasks', action: 'view', scope: 'branch' }, { module: 'billing', action: 'view', scope: 'groups', clientGroupIds: [G2] }], hiddenFields: ['client.fees'] },
];

describe('api key scope intersection', () => {
  it('keeps only requested scopes at the creator\'s best scope', () => {
    const g = keyGrants(roles, ['clients:view', 'tasks:view', 'receipts:create']);
    expect(g).toEqual([{ module: 'clients', action: 'view', scope: 'all' }, { module: 'tasks', action: 'view', scope: 'branch' }]);
  });
  it('merges group grants and narrows to the key\'s client groups without widening', () => {
    expect(keyGrants(roles, ['billing:view'])).toEqual([{ module: 'billing', action: 'view', scope: 'groups', clientGroupIds: [G1, G2] }]);
    const r = keyGrants(roles, ['clients:view', 'tasks:view', 'billing:view', 'tasks:edit'], [G2]);
    expect(r).toEqual([{ module: 'clients', action: 'view', scope: 'groups', clientGroupIds: [G2] }, { module: 'billing', action: 'view', scope: 'groups', clientGroupIds: [G2] }]);
  });
  it('key actor: hidden fields inherited; no creator grant → no right', () => {
    const a = keyActor({ userId: 'u', teamIds: [], branchId: null, roles }, ['clients:view', 'clients:delete']);
    expect(can(a, 'clients', 'view')).toBe(true);
    expect(can(a, 'clients', 'delete')).toBe(false);
    expect(a.roles[0]!.hiddenFields).toEqual(['client.fees']);
    expect(scopesNotHeld(roles, ['clients:view', 'clients:delete'])).toEqual(['clients:delete']);
  });
  it('parses keys, IP allow-lists, cursors, limiter', () => {
    expect(parseApiKey('wk_abcde12345_' + 'x'.repeat(43))).toEqual({ prefix: 'abcde12345', secret: 'x'.repeat(43) });
    expect(parseApiKey('wk_ABC_x')).toBeNull();
    expect(keyIpAllowed('10.1.2.3', [])).toBe(true);
    expect(keyIpAllowed('::ffff:203.0.113.9', ['203.0.113.0/24'])).toBe(true);
    expect(keyIpAllowed('198.51.100.1', ['203.0.113.0/24'])).toBe(false);
    expect(keyIpAllowed(null, ['203.0.113.0/24'])).toBe(false);
    expect(decodeCursor(encodeCursor(250))).toBe(250);
    expect(decodeCursor('garbage')).toBeNull();
    const l = new WindowLimiter(60_000);
    expect(l.take('k', 2, 0).ok).toBe(true); expect(l.take('k', 2, 1).ok).toBe(true);
    expect(l.take('k', 2, 2)).toEqual({ ok: false, retryAfterSec: 60 });
    expect(l.take('k', 2, 60_000).ok).toBe(true);
  });
});

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const mac = (c: string) => createHmac('sha256', secret).update(c).digest('hex');
  const body = JSON.stringify({ id: 'e1', type: 'task.created' });
  it('verifies within the window, rejects tampering, staleness and junk', () => {
    const t = 1_800_000_000;
    const header = signatureHeader(t, mac(signedContent(t, body)));
    expect(verifyWebhookSignature({ header, body, nowSec: t + 10, hmacHex: mac })).toEqual({ ok: true, timestamp: t });
    expect(verifyWebhookSignature({ header, body: body + ' ', nowSec: t, hmacHex: mac })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyWebhookSignature({ header, body, nowSec: t + 301, hmacHex: mac })).toEqual({ ok: false, reason: 'stale' });
    expect(verifyWebhookSignature({ header, body, nowSec: t - 301, hmacHex: mac })).toEqual({ ok: false, reason: 'stale' });
    expect(verifyWebhookSignature({ header: 'v1=abc', body, nowSec: t, hmacHex: mac })).toEqual({ ok: false, reason: 'malformed' });
  });
  it('backoff grows and caps; envelope carries ids and safe keys only', () => {
    expect([1, 2, 3].map(webhookBackoffMs)).toEqual([30_000, 120_000, 480_000]);
    expect(webhookBackoffMs(20)).toBe(6 * 3600_000);
    const e = webhookEnvelope({ id: 'e', type: 'invoice.issued', occurredAt: 'x', entityType: 'invoice', entityId: 'i', clientId: 'c', payload: { totalPaise: 100, status: 'issued', name: 'Ramesh' } });
    expect(e).toEqual({ id: 'e', type: 'invoice.issued', occurredAt: 'x', data: { entityType: 'invoice', entityId: 'i', clientId: 'c', status: 'issued' } });
  });
});

describe('SSRF address classification', () => {
  it.each([
    ['127.0.0.1', 'loopback'], ['127.1', 'loopback'], ['2130706433', 'loopback'], ['0177.0.0.1', 'loopback'], ['0x7f.0.0.1', 'loopback'], ['0x7f000001', 'loopback'],
    ['169.254.169.254', 'metadata'], ['0251.0376.0251.0376', 'metadata'], ['2852039166', 'metadata'], ['169.254.1.1', 'link_local'],
    ['10.0.0.1', 'private'], ['10.255.255.255', 'private'], ['172.16.0.1', 'private'], ['172.31.255.1', 'private'], ['192.168.1.1', 'private'], ['100.64.0.1', 'cgnat'],
    ['0.0.0.0', 'unspecified'], ['0', 'unspecified'], ['224.0.0.1', 'multicast'], ['255.255.255.255', 'reserved'], ['192.0.2.5', 'reserved'],
    ['::1', 'loopback'], ['::', 'unspecified'], ['0:0:0:0:0:0:0:1', 'loopback'], ['[::1]', 'loopback'], ['fe80::1', 'link_local'], ['fc00::1', 'private'], ['fd12:3456::1', 'private'],
    ['::ffff:127.0.0.1', 'loopback'], ['::ffff:7f00:1', 'loopback'], ['::ffff:a9fe:a9fe', 'metadata'], ['::ffff:10.0.0.1', 'private'], ['::127.0.0.1', 'loopback'],
    ['64:ff9b::a9fe:a9fe', 'metadata'], ['2002:7f00:1::', 'loopback'], ['fd00:ec2::254', 'metadata'], ['ff02::1', 'multicast'],
    ['8.8.8.8', 'public'], ['172.32.0.1', 'public'], ['2606:4700::1111', 'public'], ['::ffff:8.8.8.8', 'public'],
    ['1.2.3.4.5', 'invalid'], ['256.1.1.1', 'invalid'], ['08.1.1.1', 'invalid'], ['example.com', 'invalid'], ['1:2:3', 'invalid'],
  ])('%s → %s', (ip, cls) => { expect(classifyAddress(ip)).toBe(cls); });
  it('blocks everything non-public and recognises literals in any notation', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('example.com')).toBe(true);
    expect(ipLiteralOf('2130706433')).toBe('127.0.0.1');
    expect(ipLiteralOf('hooks.example.com')).toBeNull();
    expect(parseIpv4Loose('1.65535')).toBe(16842751);
  });
});

describe('password policy', () => {
  it('flags short, repeated, sequences and identity', () => {
    expect(passwordIssues('short')).toContain('too_short');
    expect(passwordIssues('aaaaaaaaaaaa')).toContain('repeated');
    expect(passwordIssues('1234567890ab')).toContain('sequence');
    expect(passwordIssues('ramesh-is-great', { email: 'ramesh@firm.in' })).toContain('contains_identity');
    expect(passwordIssues('correct horse battery', { email: 'partner@x.in', name: 'Partner' })).toEqual([]);
  });
});
