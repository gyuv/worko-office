import { Injectable, Logger } from '@nestjs/common';
import webpush from 'web-push';

export type PushSub = { id: string; kind: 'fcm' | 'webpush'; endpoint: string; keys: { p256dh?: string; auth?: string } | null };
export type PushPayload = { id: string; title: string; body: string; category: string; priority: string; entityType?: string | null; entityId?: string | null };
/** 'gone' = the endpoint is permanently invalid (uninstalled app, expired subscription) → disable it. Throw for transient errors. */
export type PushResult = 'sent' | 'gone';
export interface PushProvider { send(sub: PushSub, payload: PushPayload): Promise<PushResult> }
export const PUSH_PROVIDERS = 'PUSH_PROVIDERS';
export type PushProviders = Record<PushSub['kind'], PushProvider>;

/** Records sends; tests can script failures. Default for dev and for any channel without credentials. */
export class MockPushProvider implements PushProvider {
  readonly sent: Array<{ sub: PushSub; payload: PushPayload }> = [];
  readonly gone = new Set<string>();
  failNext = 0;
  async send(sub: PushSub, payload: PushPayload): Promise<PushResult> {
    if (this.failNext > 0) { this.failNext--; throw new Error('mock transient failure'); }
    if (this.gone.has(sub.endpoint)) return 'gone';
    this.sent.push({ sub, payload });
    return 'sent';
  }
}

/** Standard Web Push (RFC 8030/8291) with VAPID. Payload is end-to-end encrypted to the browser. */
@Injectable()
export class WebPushProvider implements PushProvider {
  private log = new Logger('WebPush');
  constructor() {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:support@worko.in', process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  }
  async send(sub: PushSub, payload: PushPayload): Promise<PushResult> {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.keys?.p256dh ?? '', auth: sub.keys?.auth ?? '' } },
        JSON.stringify(payload), { TTL: 24 * 3600, urgency: payload.priority === 'critical' || payload.priority === 'high' ? 'high' : 'normal' });
      return 'sent';
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) return 'gone';
      this.log.warn(`push failed (${code ?? 'network'})`);
      throw e;
    }
  }
}

/**
 * FCM HTTP v1 needs a Firebase service account (OAuth2) — not available yet, so FCM uses the mock.
 * VERIFY AGAINST OFFICIAL DOCS (firebase.google.com/docs/cloud-messaging/send-message) when wiring the real adapter.
 */
export function pushProvidersFactory(): PushProviders {
  const webpushReady = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  return { webpush: webpushReady ? new WebPushProvider() : new MockPushProvider(), fcm: new MockPushProvider() };
}
