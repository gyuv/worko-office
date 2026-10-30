#!/usr/bin/env node
/**
 * "Firm's day" browser smoke (PRD §15, subset: steps 1, 2, 3, 5, 7 and 8 through the real web UI).
 * The full ten steps run as API e2e in apps/api/test/firmsday.e2e.test.ts; this script proves the same day renders
 * in the browser. Setup that has no UI value (rates, rule-pack tasks) goes through the API; every assertion is on
 * what a person sees.
 *
 * Needs a running API + web (scripts/e2e/run-firmsday-web.sh starts both on spare ports and stops them):
 *   API_URL        e.g. http://localhost:3310/v1   (NODE_ENV=development, PAYMENT_PROVIDER=mock, PORTAL_DEV_LOG_OTP=1)
 *   WEB_URL        e.g. http://localhost:5310/     (vite dev or a static build pointing at API_URL)
 *   OTP_LOG_FILE   the API's log file — the dev-only OTP line is read from it for the portal sign-in
 *   CHROMIUM_PATH  optional browser executable (otherwise Playwright's own)
 *   PLAYWRIGHT_MODULE  optional path to the playwright package (it is not a repo dependency, D206)
 *   PAYMENT_WEBHOOK_SECRET  as configured on the API (empty → the dev default)
 * Exit code 0 = all checks passed.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const API = (process.env.API_URL ?? 'http://localhost:3000/v1').replace(/\/$/, '');
const WEB = (process.env.WEB_URL ?? 'http://localhost:5173/').replace(/\/?$/, '/');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const SLUG = `fd${Date.now().toString(36)}`;
const PW = 'Firmsday@12345';
const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log(`ok   ${name}`); }
  catch (e) {
    results.push({ name, ok: false, error: e.message }); console.log(`FAIL ${name}: ${e.message}`);
    for (const pg of browser.contexts().flatMap((c) => c.pages())) console.log(`  page ${pg.url()}: ${(await pg.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400)}`);
    throw e;
  }
};

async function api(method, path, body, token) {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
function gstin(state, n) { // mod-36 check character, same algorithm as @worko/domain
  const cs = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; const base = `${state}AABCW${String(n).padStart(4, '0')}Q1Z`;
  let sum = 0; for (let i = 0; i < 14; i++) { const p = cs.indexOf(base[i]) * (i % 2 ? 2 : 1); sum += Math.floor(p / 36) + (p % 36); }
  return base + cs[(36 - (sum % 36)) % 36];
}
const istMonth = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 7);
const prevMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const trace = (pg) => { pg.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`  console.${m.type()}: ${m.text().slice(0, 300)}`); }); pg.on('requestfailed', (r) => console.log(`  request failed: ${r.method()} ${r.url()} ${r.failure()?.errorText}`)); pg.on('response', (r) => { if (r.status() >= 400) console.log(`  ${r.status()} ${r.request().method()} ${r.url()}`); }); };
trace(page);
let partner; let clientId; let invoiceId; let invoiceNo;
const clientName = 'Sahyadri Agro Pvt Ltd';
try {
  await step('1. firm set-up (API) and partner signs in through the login screen', async () => {
    await api('POST', '/tenants/signup', { firmName: `Firms Day ${SLUG}`, slug: SLUG, stateCode: '27', partner: { name: 'Partner', email: `partner@${SLUG}.in`, password: PW } });
    partner = await api('POST', '/auth/login', { firm: SLUG, email: `partner@${SLUG}.in`, password: PW, device: { platform: 'web' } });
    const [e1] = await api('GET', '/billing/entities', null, partner.accessToken);
    await api('PATCH', `/billing/entities/${e1.id}`, { gstin: gstin('27', 1), invoicePrefix: 'FD' }, partner.accessToken);
    await api('PUT', '/billing/settings', { defaultEntityId: e1.id }, partner.accessToken);
    await api('POST', '/service-types/install-defaults', null, partner.accessToken);
    await page.goto(WEB);
    await page.locator('#firm').fill(SLUG);
    await page.locator('#email').fill(`partner@${SLUG}.in`);
    await page.locator('#password').fill(PW);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('navigation').first().waitFor({ timeout: 15_000 });
  });

  await step('2. client onboarded (GSTIN, contact, GSTR-3B) shows in Clients', async () => {
    const st = await api('GET', '/service-types', null, partner.accessToken);
    const g3b = st.find((s) => s.key === 'GSTR3B');
    await api('POST', '/billing/rates', { serviceTypeId: g3b.id, amountPaise: 150_000, effectiveFrom: '2026-04-01' }, partner.accessToken);
    clientId = (await api('POST', '/clients', { name: clientName, entityType: 'PRIVATE_COMPANY', registrations: [{ kind: 'GSTIN', number: gstin('27', 2), isPrimary: true }],
      contacts: [{ name: 'Ramesh Patil', email: `ramesh@${SLUG}.example`, isPrimary: true }] }, partner.accessToken)).id;
    await api('PUT', `/clients/${clientId}/services/${g3b.id}`, {}, partner.accessToken);
    await page.goto(`${WEB}#/clients`);
    await page.getByText(clientName).first().waitFor({ timeout: 15_000 });
  });

  await step('3. auto-created GSTR-3B task shows in Tasks', async () => {
    const month = prevMonth(istMonth());
    await api('POST', '/tasks/auto/commit', { month }, partner.accessToken);
    await page.goto(`${WEB}#/tasks`);
    await page.getByText(/GSTR-3B — /).first().waitFor({ timeout: 15_000 });
  });

  await step('7. done task auto-billed and issued; invoice number shows in Billing', async () => {
    const tasks = (await api('GET', '/tasks?limit=50', null, partner.accessToken)).items;
    const task = tasks.find((x) => x.clientId === clientId);
    for (const c of (await api('GET', `/tasks/${task.id}`, null, partner.accessToken)).checks) await api('POST', `/tasks/${task.id}/checks`, { key: c.key, done: true }, partner.accessToken);
    await api('PATCH', `/tasks/${task.id}`, { status: 'review', reviewer_id: partner.userId }, partner.accessToken);
    await api('PATCH', `/tasks/${task.id}`, { status: 'done' }, partner.accessToken);
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    invoiceId = (await api('POST', '/billing/auto/commit', { to: today }, partner.accessToken)).ids[0];
    invoiceNo = (await api('POST', `/billing/invoices/${invoiceId}/issue`, { issueDate: today }, partner.accessToken)).number;
    await page.goto(`${WEB}#/billing`);
    await page.getByText(invoiceNo).first().waitFor({ timeout: 15_000 });
  });

  await step('5+8. client signs in to the portal with an OTP, sees the invoice, pays (mock gateway webhook) → paid', async () => {
    const contactId = (await api('GET', `/clients/${clientId}`, null, partner.accessToken)).contacts[0].id;
    await api('POST', '/portal-admin/invites', { clientId, contactId, send: false }, partner.accessToken);
    const ctx = await browser.newContext(); const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message)); trace(p);
    await p.goto(`${WEB}#/portal/${SLUG}`);
    const before = process.env.OTP_LOG_FILE ? readFileSync(process.env.OTP_LOG_FILE, 'utf8').length : 0;
    await p.getByRole('textbox').first().fill(`ramesh@${SLUG}.example`);
    await p.getByRole('button', { name: 'Send code' }).click();
    if (!process.env.OTP_LOG_FILE) throw new Error('OTP_LOG_FILE not set — cannot read the dev OTP');
    let code = null;
    for (let i = 0; i < 40 && !code; i++) {
      await new Promise((r) => setTimeout(r, 250));
      code = /code for [^:]+: (\d{6})/.exec(readFileSync(process.env.OTP_LOG_FILE, 'utf8').slice(before))?.[1] ?? null;
    }
    if (!code) throw new Error('no OTP in the API log (NODE_ENV=development and PORTAL_DEV_LOG_OTP=1?)');
    await p.getByLabel('6-digit code').fill(code);
    await p.getByRole('button', { name: 'Sign in' }).click();
    await p.getByText(clientName).first().waitFor({ timeout: 15_000 });
    await p.goto(`${WEB}#/portal/${SLUG}/invoices?clientId=${clientId}`);
    await p.getByText(invoiceNo).first().waitFor({ timeout: 15_000 });
    await p.getByText('Unpaid', { exact: true }).first().waitFor({ timeout: 15_000 });
    // The client's "Pay" goes to the gateway; with the mock provider the gateway's webhook is simulated here.
    const inv = await api('GET', `/billing/invoices/${invoiceId}`, null, partner.accessToken);
    const link = await api('POST', `/billing/invoices/${invoiceId}/payment-link`, {}, partner.accessToken);
    const body = JSON.stringify({ id: `evt_${SLUG}`, type: 'payment.captured', linkId: link.url.split('/').pop(), paymentId: `pay_${SLUG}`, amountPaise: inv.totalPaise });
    const sig = createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET || 'worko-dev-webhook-secret').update(body).digest('hex');
    const r = await fetch(`${API}/billing/webhooks/mock/${partner.tenantId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-worko-signature': sig }, body });
    if (!r.ok) throw new Error(`webhook ${r.status}`);
    await p.reload();
    await p.getByText(invoiceNo).first().waitFor({ timeout: 15_000 });
    await p.getByText('Unpaid', { exact: true }).first().waitFor({ state: 'detached', timeout: 15_000 });
    await p.getByText('Paid', { exact: true }).first().waitFor({ timeout: 15_000 });
    await ctx.close();
  });

  await step('8b. office sees the gateway receipt in Receipts', async () => {
    await page.goto(`${WEB}#/receipts`);
    await page.getByText(clientName).first().waitFor({ timeout: 15_000 });
  });
  if (errors.length) throw new Error(`uncaught page errors: ${errors.slice(0, 3).join(' | ')}`);
} catch { process.exitCode = 1; } finally {
  await browser.close();
  console.log(JSON.stringify({ firm: SLUG, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, pageErrors: errors.length }));
}
