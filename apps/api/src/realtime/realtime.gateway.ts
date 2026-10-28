import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { TokenService } from '../auth/token.service.js';
import { DbService } from '../db/db.service.js';
import { RealtimeService, type RealtimeEvent } from './realtime.service.js';

type Conn = { ws: WebSocket; tenantId: string; userId: string; sessionId: string; alive: boolean; exp: number };
export const REALTIME_PATH = '/v1/realtime';
const AUTH_TIMEOUT_MS = 5_000;

/**
 * Change-feed WebSocket. Protocol (JSON):
 *  → {type:'auth', token}           (first message; tokens never go in the URL, so they stay out of logs)
 *  ← {type:'ready'}                  then  ← {type:'changed', cursor}  — client pulls /sync/pull?since=…
 *  ← {type:'revoked', wipe}          session revoked/wiped → client signs out (and erases data if wipe)
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private log = new Logger('Realtime');
  private wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  private conns = new Set<Conn>();
  private unsub?: () => void;
  private heartbeat?: NodeJS.Timeout;

  constructor(private host: HttpAdapterHost, private tokens: TokenService, private db: DbService, private realtime: RealtimeService) {}

  onApplicationBootstrap() {
    const server = this.host.httpAdapter?.getHttpServer() as Server | undefined;
    if (!server) return;
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(req.url ?? '/', 'http://x').pathname !== REALTIME_PATH) return;
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
    this.unsub = this.realtime.subscribe((e) => this.fanOut(e));
    this.heartbeat = setInterval(() => void this.sweep(), 30_000).unref();
  }

  onApplicationShutdown() {
    this.unsub?.(); clearInterval(this.heartbeat);
    for (const c of this.conns) c.ws.close(1001);
    this.wss.close();
  }

  get connectionCount() { return this.conns.size; }

  /**
   * Heartbeat + re-validation: drop dead peers, close sockets whose access token expired (4401 → client
   * refreshes and reconnects) and whose session or user is no longer active.
   */
  async sweep(now = Date.now()) {
    for (const c of this.conns) {
      if (!c.alive) { c.ws.terminate(); this.conns.delete(c); continue; }
      if (now >= c.exp) { c.ws.close(4401, 'token expired'); continue; }
      c.alive = false; c.ws.ping();
    }
    const byTenant = new Map<string, Conn[]>();
    for (const c of this.conns) byTenant.set(c.tenantId, [...(byTenant.get(c.tenantId) ?? []), c]);
    for (const [tenantId, conns] of byTenant) {
      const ok = new Set(await this.db.tenantTx(tenantId, async (tx) => (await tx.query(
        `SELECT s.id FROM device_session s JOIN app_user u ON u.id = s.user_id
         WHERE s.id = ANY($1) AND s.revoked_at IS NULL AND s.wipe_requested_at IS NULL AND u.status = 'active'`,
        [conns.map((c) => c.sessionId)])).rows.map((r) => r.id as string)).catch(() => conns.map((c) => c.sessionId)));
      for (const c of conns) if (!ok.has(c.sessionId)) c.ws.close(4403, 'session ended');
    }
  }

  private onConnection(ws: WebSocket) {
    const timer = setTimeout(() => ws.close(4401, 'auth timeout'), AUTH_TIMEOUT_MS);
    ws.once('message', async (raw) => {
      clearTimeout(timer);
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; token?: string };
        if (msg.type !== 'auth' || typeof msg.token !== 'string') throw new Error('bad auth');
        const c = await this.tokens.verify(msg.token);
        const ok = await this.db.tenantTx(c.tid, async (tx) => (await tx.query(
          `SELECT 1 FROM device_session s JOIN app_user u ON u.id = s.user_id
           WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.wipe_requested_at IS NULL AND u.status = 'active'`, [c.sid, c.sub])).rowCount);
        if (!ok) throw new Error('session');
        const conn: Conn = { ws, tenantId: c.tid, userId: c.sub, sessionId: c.sid, alive: true, exp: c.exp * 1000 };
        this.conns.add(conn);
        ws.on('pong', () => (conn.alive = true));
        ws.on('close', () => this.conns.delete(conn));
        ws.on('message', () => { /* client → server traffic is not used beyond auth */ });
        ws.send(JSON.stringify({ type: 'ready' }));
      } catch {
        ws.close(4401, 'unauthorized');
      }
    });
  }

  private fanOut(e: RealtimeEvent) {
    for (const c of this.conns) {
      if (c.tenantId !== e.tenantId || c.ws.readyState !== WebSocket.OPEN) continue;
      if (e.type === 'changed') {
        if (!e.userIds || e.userIds.includes(c.userId)) c.ws.send(JSON.stringify({ type: 'changed', cursor: e.cursor }));
      } else if (e.sessionId === c.sessionId) {
        c.ws.send(JSON.stringify({ type: 'revoked', wipe: e.wipe }));
        c.ws.close(4403, 'revoked');
      }
    }
  }
}
