import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Which outside services this deployment is actually connected to. A module or button that needs one is hidden
 * (and its routes refuse with 503 INTEGRATION_NOT_CONFIGURED) until the service is configured, so a fresh deployment
 * never shows features that would silently do nothing. Outside production every integration counts as available
 * (mocks), unless HIDE_UNCONFIGURED=1 is set to preview the production view.
 */
export type IntegrationKey = 'ai' | 'payments' | 'email' | 'sms' | 'whatsapp' | 'messaging' | 'esign' | 'portal' | 'calendarSync' | 'noticeExtraction' | 'gstinLookup';
export type Integrations = Record<IntegrationKey, boolean>;

const real = (v: string | undefined) => !!v && !['mock', 'none', 'off', 'disabled'].includes(v.toLowerCase());
const yes = (v: string | undefined) => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());

export function integrations(env: NodeJS.ProcessEnv = process.env): Integrations {
  const enforce = env.NODE_ENV === 'production' || yes(env.HIDE_UNCONFIGURED);
  const ai = real(env.AI_PROVIDER) && !!env.ANTHROPIC_API_KEY && !yes(env.AI_DISABLED);
  const email = real(env.COMM_EMAIL_PROVIDER) && !!env.SMTP_HOST;
  const sms = real(env.COMM_SMS_PROVIDER) && !!env.SMS_API_URL && !!env.SMS_API_KEY;
  const whatsapp = real(env.COMM_WHATSAPP_PROVIDER) && !!env.WHATSAPP_PHONE_NUMBER_ID && !!env.WHATSAPP_TOKEN;
  const actual: Integrations = {
    ai, email, sms, whatsapp,
    messaging: email || sms || whatsapp,
    payments: real(env.PAYMENT_PROVIDER) && !!env.RAZORPAY_KEY_ID && !!env.RAZORPAY_KEY_SECRET,
    esign: real(env.ESIGN_PROVIDER) && !!env.ESIGN_ASP_URL,
    // clients sign in to the portal with a one-time code sent by email or SMS
    portal: email || sms,
    calendarSync: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) || !!(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET),
    noticeExtraction: real(env.NOTICE_EXTRACTOR) || ai,
    // only a mock adapter exists today (lookup/gstin.provider.ts)
    gstinLookup: false,
  };
  if (!enforce) return Object.fromEntries(Object.keys(actual).map((k) => [k, true])) as Integrations;
  return actual;
}

/** Throws 503 when the deployment isn't connected to the service a route needs. */
export function requireIntegration(key: IntegrationKey) {
  if (!integrations()[key]) {
    throw new HttpException({ code: 'INTEGRATION_NOT_CONFIGURED', message: `This feature isn't set up on this server yet (${key}).`, integration: key }, HttpStatus.SERVICE_UNAVAILABLE);
  }
}
