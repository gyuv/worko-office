/** Minimal WebSocket surface shared by browsers, React Native and the `ws` package. */
export interface WsLike {
  readyState: number; send(d: string): void; close(code?: number): void;
  onopen: ((e: unknown) => void) | null; onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number }) => void) | null; onerror: ((e: unknown) => void) | null;
}

/**
 * Change-feed client: authenticates with the first message, calls `onChanged` on server hints,
 * reconnects with jittered backoff, and stops for good when the session is revoked (4401/4403).
 */
export class RealtimeClient {
  private ws: WsLike | null = null;
  private attempts = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private o: {
    url: string; createSocket: (url: string) => WsLike; getToken: () => string | null | Promise<string | null>;
    onChanged: (cursor: number) => void; onRevoked?: (wipe: boolean) => void; onUnauthorized?: () => void;
    onConnected?: (connected: boolean) => void; random?: () => number;
  }) {}

  start() { this.stopped = false; void this.connect(); }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close(1000); this.ws = null;
  }

  /** e.g. on `online` events — reconnect now instead of waiting for the backoff. */
  nudge() { if (!this.stopped && !this.ws) { if (this.timer) clearTimeout(this.timer); void this.connect(); } }

  private async connect() {
    this.timer = null;
    const token = await this.o.getToken();
    if (!token || this.stopped) return;
    const ws = this.o.createSocket(this.o.url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
    ws.onmessage = (e) => {
      let m: { type?: string; cursor?: number; wipe?: boolean };
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.type === 'ready') { this.attempts = 0; this.o.onConnected?.(true); this.o.onChanged(-1); }
      else if (m.type === 'changed' && typeof m.cursor === 'number') this.o.onChanged(m.cursor);
      else if (m.type === 'revoked') { this.stopped = true; this.o.onRevoked?.(!!m.wipe); }
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (e) => {
      this.ws = null; this.o.onConnected?.(false);
      if (this.stopped) return;
      // 4401: token expired/invalid → let the app refresh, then reconnect quickly.
      if (e.code === 4401) this.o.onUnauthorized?.();
      if (e.code === 4403) { this.stopped = true; return; }
      const base = Math.min(30_000, 500 * 2 ** this.attempts++);
      this.timer = setTimeout(() => void this.connect(), base / 2 + (this.o.random ?? Math.random)() * base / 2);
    };
  }
}
