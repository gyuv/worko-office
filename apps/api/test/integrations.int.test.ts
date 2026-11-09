import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integrations } from '../src/common/integrations.js';
import { bearer, bootApp, type Session } from './helpers.js';

describe('integrations()', () => {
  it('outside production everything counts as available (mocks)', () => {
    expect(Object.values(integrations({ NODE_ENV: 'test' })).every(Boolean)).toBe(true);
  });
  it('in production only configured services count; mock/none never do', () => {
    const none = integrations({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'none', COMM_EMAIL_PROVIDER: 'mock', AI_PROVIDER: 'anthropic' });
    expect(none).toEqual({ ai: false, payments: false, email: false, sms: false, whatsapp: false, messaging: false, esign: false, portal: false, calendarSync: false, noticeExtraction: false, gstinLookup: false });
    const some = integrations({ NODE_ENV: 'production', AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', COMM_EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com', PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'a', RAZORPAY_KEY_SECRET: 'b' });
    expect(some).toMatchObject({ ai: true, email: true, messaging: true, portal: true, payments: true, noticeExtraction: true, whatsapp: false, esign: false });
    expect(integrations({ NODE_ENV: 'production', AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', AI_DISABLED: '1' }).ai).toBe(false);
  });
});

describe('unconfigured integrations are hidden and refused (production view)', () => {
  let t: Awaited<ReturnType<typeof bootApp>>; let P: Session;
  beforeAll(async () => { t = await bootApp(); P = await t.signup('integ'); }, 60_000);
  afterAll(async () => { delete process.env.HIDE_UNCONFIGURED; await t?.close(); });

  it('/me reports features off and the routes answer 503 INTEGRATION_NOT_CONFIGURED', async () => {
    expect((await t.http().get('/v1/me').set(bearer(P.accessToken)).expect(200)).body.features.ai).toBe(true);
    process.env.HIDE_UNCONFIGURED = '1';
    const me = (await t.http().get('/v1/me').set(bearer(P.accessToken)).expect(200)).body;
    expect(me.features).toMatchObject({ ai: false, payments: false, whatsapp: false, esign: false, portal: false, leads: true, reports: true, automation: true });
    expect(me.integrations.messaging).toBe(false);
    const r = await t.http().get('/v1/lookup/gstin/27AAPFU0939F1ZV').set(bearer(P.accessToken));
    expect(r.status).toBe(503); expect(r.body.code).toBe('INTEGRATION_NOT_CONFIGURED');
    // @Feature-guarded modules are refused too
    expect((await t.http().get('/v1/ai/settings').set(bearer(P.accessToken))).status).toBeGreaterThanOrEqual(400);
  });
});
