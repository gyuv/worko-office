import type { INestApplication, LoggerService } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedactingLogger, redactLog } from './logger.js';

/** Upper bound on any non-multipart request body (uploads have their own per-route multer limit) — D199. */
export const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 1024 * 1024);

type Req = { method: string; originalUrl?: string; url: string; headers: Record<string, string | string[] | undefined>; apiKey?: { prefix: string }; id?: string };
type Res = { setHeader(k: string, v: string): void; statusCode: number; on(ev: 'finish', f: () => void): void; status(n: number): Res; json(b: unknown): void };

/**
 * HTTP hardening applied by main.ts AND the test harness (so tests exercise it): security headers (CSP for JSON
 * responses, HSTS, nosniff, frame deny, no referrer, no x-powered-by), request ids, a global body-size cap, and an
 * access log through the PII-redacting logger (query values are dropped — only the path is logged).
 */
export function applyHttpHardening(app: INestApplication, opts: { logger?: LoggerService; accessLog?: boolean } = {}) {
  const logger = opts.logger ?? new RedactingLogger();
  app.useLogger(logger);
  const accessLog = opts.accessLog ?? (process.env.ACCESS_LOG === '1' || process.env.NODE_ENV === 'production');
  const express = app.getHttpAdapter().getInstance();
  express.disable?.('x-powered-by');
  app.use((req: Req, res: Res, next: () => void) => {
    const rid = typeof req.headers['x-request-id'] === 'string' && /^[\w-]{8,64}$/.test(req.headers['x-request-id']) ? req.headers['x-request-id'] : randomUUID();
    req.id = rid;
    res.setHeader('X-Request-Id', rid);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const len = Number(req.headers['content-length'] ?? 0);
    const ct = String(req.headers['content-type'] ?? '');
    if (len > MAX_BODY_BYTES && !ct.startsWith('multipart/form-data')) {
      res.status(413).json({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' });
      return;
    }
    if (accessLog) {
      const t0 = Date.now();
      res.on('finish', () => logger.log(`${req.method} ${redactLog((req.originalUrl ?? req.url).split('?')[0]!)} ${res.statusCode} ${Date.now() - t0}ms rid=${rid}${req.apiKey ? ` key=${req.apiKey.prefix}` : ''}`, 'HTTP'));
    }
    next();
  });
}
