import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { AppModule } from '../src/app.module.js';

/** Every implemented route must be in docs/openapi.yaml and vice versa (contract-first). */
describe('OpenAPI contract', () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres://unused/unused'; // pool connects lazily; no queries here
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.setGlobalPrefix('v1');
    await app.init();
  });
  afterAll(() => app.close());

  it('routes match the spec', () => {
    const stack = app.getHttpAdapter().getInstance()._router.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    const impl = stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route!.methods).map((m) =>
      `${m.toUpperCase()} ${l.route!.path.replace(/^\/v1/, '').replace(/:(\w+)/g, '{$1}')}`)).sort();
    const spec = parse(readFileSync(new URL('../../../docs/openapi.yaml', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
    const documented = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)).sort();
    expect(impl).toEqual(documented);
  });
});
