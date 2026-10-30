import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { applyHttpHardening } from '../src/common/hardening.js';
import { RedactingLogger } from '../src/common/logger.js';
import { freshDatabase } from './db.js';

export const PW = 'correct horse battery';
export const web = { platform: 'web', label: 'Chrome' } as const;
export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
export type Session = { accessToken: string; refreshToken: string; sessionId: string; tenantId: string; userId: string };

/** Boots the full app on a throwaway database. `listen` is needed for WebSocket tests. */
export async function bootApp(opts: { listen?: boolean; override?: (b: TestingModuleBuilder) => TestingModuleBuilder } = {}) {
  const db = await freshDatabase();
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (opts.override) builder = opts.override(builder);
  const app: INestApplication = (await builder.compile()).createNestApplication({ rawBody: true });
  app.setGlobalPrefix('v1');
  applyHttpHardening(app, { logger: new RedactingLogger(undefined, ['error', 'fatal']) });
  if (opts.listen) await app.listen(0, '127.0.0.1'); else await app.init();
  const http = () => request(app.getHttpServer());
  const sql = async <T = Record<string, unknown>>(q: string, p: unknown[] = []) => {
    const c = new pg.Client({ connectionString: db.url }); await c.connect();
    try { return (await c.query(q, p)).rows as T[]; } finally { await c.end(); }
  };
  async function signup(slug: string, email = `partner@${slug}.in`): Promise<Session> {
    await http().post('/v1/tenants/signup').send({ firmName: `${slug} & Co`, slug, stateCode: '27', partner: { name: 'Partner', email, password: PW } }).expect(201);
    return login(slug, email);
  }
  async function login(slug: string, email: string, platform: 'web' | 'desktop' | 'android' = 'web'): Promise<Session> {
    return (await http().post('/v1/auth/login').send({ firm: slug, email, password: PW, device: { platform } }).expect(200)).body;
  }
  async function addUser(owner: Session, slug: string, name: string, role: string, extra: Record<string, unknown> = {}): Promise<Session> {
    const email = `${name.toLowerCase()}@${slug}.in`;
    await http().post('/v1/users').set(bearer(owner.accessToken)).send({ name, email, password: PW, roleKeys: [role], ...extra }).expect(201);
    return login(slug, email);
  }
  return { app, db, http, sql, signup, login, addUser, close: async () => { await app.close(); await db.drop(); } };
}
