import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';

describe('API', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication(); app.setGlobalPrefix('v1'); await app.init();
  });
  afterAll(() => app.close());

  it('health', () => request(app.getHttpServer()).get('/v1/health').expect(200, { status: 'ok', product: 'Worko' }));

  it('rejects invalid preview body', () => request(app.getHttpServer()).post('/v1/rules/preview').send({ fy: 'x' }).expect(400));

  it('reports extension impact', async () => {
    const clients = Array.from({ length: 412 }, (_, i) => ({ id: `c${i}`, gstRegistered: true, gstFiling: 'MONTHLY' }));
    const res = await request(app.getHttpServer()).post('/v1/rules/extension-impact').send({
      fy: 2026, clients,
      extensions: [{ id: 'n1', ruleId: 'gst.gstr3b.monthly', periodKey: '2026-09', newDueDate: '2026-10-25' }],
    }).expect(201);
    expect(res.body.clientsAffected).toBe(412);
    expect(res.body.dueDatesChanged).toBe(1);
  });
});
