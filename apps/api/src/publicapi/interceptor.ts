import { BadRequestException, CallHandler, ConflictException, ExecutionContext, Injectable, NestInterceptor, UnprocessableEntityException } from '@nestjs/common';
import { decodeCursor, encodeCursor } from '@worko/domain';
import { createHash } from 'node:crypto';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { DbService } from '../db/db.service.js';
import type { ApiKeyPrincipal } from './decorators.js';

const DEFAULT_LIMIT = 50;
type Req = { method: string; path: string; query: Record<string, unknown>; body: unknown; headers: Record<string, string | undefined>; apiKey?: ApiKeyPrincipal };
type Res = { status(n: number): Res; statusCode: number; setHeader(k: string, v: string): void };

/**
 * Public-API conventions for API-key requests only (staff/portal requests pass straight through) — D191:
 * - `cursor` (opaque) instead of `offset`; default `limit` 50; list responses gain `nextCursor` (null at the end).
 * - `Idempotency-Key` on POST/PATCH: first response stored per key (existing `idempotency_key` table, namespaced
 *   `api:<keyId>:<key>`) and replayed (`Idempotent-Replayed: true`); same key + different request → 422; still running → 409.
 */
@Injectable()
export class PublicApiInterceptor implements NestInterceptor {
  constructor(private db: DbService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Req>();
    if (!req.apiKey) return next.handle();
    return from(this.run(req, ctx.switchToHttp().getResponse<Res>(), next));
  }

  private async run(req: Req, res: Res, next: CallHandler): Promise<unknown> {
    let offset = 0, limit = DEFAULT_LIMIT;
    if (req.method === 'GET') {
      const q = req.query;
      if (q.offset !== undefined) throw new BadRequestException({ code: 'USE_CURSOR', message: 'Use `cursor` for pagination' });
      if (typeof q.cursor === 'string') {
        const o = decodeCursor(q.cursor);
        if (o === null) throw new BadRequestException({ code: 'INVALID_CURSOR', message: 'Invalid cursor' });
        offset = o;
      }
      if (q.limit !== undefined) limit = Number(q.limit);
      delete q.cursor;
      q.offset = String(offset);
      q.limit = String(Number.isFinite(limit) ? limit : DEFAULT_LIMIT);
    }
    const idem = req.headers['idempotency-key'];
    if (!idem || (req.method !== 'POST' && req.method !== 'PATCH')) return this.page(await lastValueFrom(next.handle(), { defaultValue: undefined }), offset, limit, req.method);
    if (idem.length > 200) throw new BadRequestException({ code: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency-Key is too long' });
    const k = req.apiKey!;
    const key = `api:${k.id}:${idem}`;
    const fp = createHash('sha256').update(`${req.method} ${req.path}\n${JSON.stringify(req.body ?? null)}`).digest('hex');
    const claimed = await this.db.tenantTx(k.tenantId, async (tx) => {
      const ins = await tx.query(`INSERT INTO idempotency_key (tenant_id, key, response) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key`, [k.tenantId, key, { state: 'pending', fp }]);
      if (ins.rowCount) return null;
      return (await tx.query('SELECT response FROM idempotency_key WHERE key = $1', [key])).rows[0]?.response as { state: string; fp: string; status?: number; body?: unknown };
    });
    if (claimed) {
      if (claimed.fp !== fp) throw new UnprocessableEntityException({ code: 'IDEMPOTENCY_MISMATCH', message: 'This Idempotency-Key was used with a different request' });
      if (claimed.state !== 'done') throw new ConflictException({ code: 'IDEMPOTENCY_IN_PROGRESS', message: 'A request with this Idempotency-Key is still running' });
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(claimed.status ?? 200);
      return claimed.body ?? undefined;
    }
    try {
      const body = await lastValueFrom(next.handle(), { defaultValue: undefined });
      await this.db.tenantTx(k.tenantId, (tx) => tx.query('UPDATE idempotency_key SET response = $2 WHERE key = $1', [key, { state: 'done', fp, status: res.statusCode, body: body ?? null }]));
      return body;
    } catch (e) {
      // Failed requests release the key so the caller can retry with the same one.
      await this.db.tenantTx(k.tenantId, (tx) => tx.query('DELETE FROM idempotency_key WHERE key = $1', [key])).catch(() => undefined);
      throw e;
    }
  }

  private page(body: unknown, offset: number, limit: number, method: string) {
    if (method !== 'GET' || !body || typeof body !== 'object' || !Array.isArray((body as { items?: unknown }).items)) return body;
    const b = body as { items: unknown[]; total?: number };
    const more = typeof b.total === 'number' ? offset + b.items.length < b.total : b.items.length >= limit;
    return { ...b, nextCursor: more && b.items.length > 0 ? encodeCursor(offset + b.items.length) : null };
  }
}
