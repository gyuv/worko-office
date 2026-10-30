import { BLOCKED_HOSTNAMES, ipLiteralOf, isBlockedAddress } from '@worko/domain';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

/**
 * Outbound webhook HTTP (D197). `resolve` and `post` are split so the caller can check EVERY resolved address and then
 * connect to the exact address it checked (DNS pinning — a second lookup can't rebind to 127.0.0.1). Redirects are never
 * followed. Tests inject a mock transport.
 */
export interface WebhookTransport {
  resolve(host: string): Promise<string[]>;
  post(o: { url: URL; address: string; headers: Record<string, string>; body: string; timeoutMs: number }): Promise<{ status: number }>;
}
export const WEBHOOK_TRANSPORT = 'WEBHOOK_TRANSPORT';

export class NodeWebhookTransport implements WebhookTransport {
  async resolve(host: string) { return (await lookup(host, { all: true, verbatim: true })).map((r) => r.address); }
  post(o: { url: URL; address: string; headers: Record<string, string>; body: string; timeoutMs: number }): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
      const host = o.url.hostname.replace(/^\[|\]$/g, '');
      const req = request({
        host: o.address, port: o.url.port || 443, path: `${o.url.pathname}${o.url.search}`, method: 'POST', timeout: o.timeoutMs,
        servername: isIP(host) ? undefined : host, headers: { ...o.headers, host: o.url.host, 'content-length': Buffer.byteLength(o.body).toString() },
      }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0 })); res.on('error', reject); });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(o.body);
    });
  }
}

export class TargetError extends Error { constructor(readonly code: 'blocked_address' | 'dns_failed') { super(code); } }

/** Resolves the URL's host and returns one address to pin — refusing if ANY resolved address is non-public. */
export async function pinTarget(t: WebhookTransport, url: URL): Promise<string> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.test(host)) throw new TargetError('blocked_address');
  const lit = ipLiteralOf(host);
  let addrs: string[];
  if (lit) addrs = [lit];
  else {
    try { addrs = await t.resolve(host); } catch { throw new TargetError('dns_failed'); }
  }
  if (!addrs.length) throw new TargetError('dns_failed');
  if (addrs.some(isBlockedAddress)) throw new TargetError('blocked_address');
  return addrs[0]!;
}
