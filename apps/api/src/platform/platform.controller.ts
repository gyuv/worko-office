import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { BILLING_CYCLES, effectiveScope, IMPERSONATION_MAX_MINUTES, planSchema, SAAS_FEATURES } from '@worko/domain';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentActor, CurrentPlatform, Perm, PlatformRoute, Public, type PlatformActor, type RequestActor } from '../auth/context.js';
import { Clock } from '../common/clock.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ImpersonationService } from './impersonation.service.js';
import { PlatformAuditService } from './platform-audit.service.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { SaasService } from './saas.service.js';

const uuid = new ParseUUIDPipe();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const loginB = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200), totp: z.string().regex(/^\d{6}$/).optional() }).strict();
const listQ = z.object({ q: z.string().trim().max(100).optional(), status: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).strict();
const suspendB = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const flagsB = z.object({ overrides: z.record(z.enum(SAAS_FEATURES), z.boolean().nullable()) }).strict();
const planB = z.object({ planKey: z.string().max(31), cycle: z.enum(BILLING_CYCLES).optional(), seatLimit: z.number().int().positive().nullable().optional() }).strict();
const runB = z.object({ today: isoDate.optional() }).strict();
const impB = z.object({ reason: z.string().trim().min(10).max(500), write: z.boolean().default(false), minutes: z.number().int().min(5).max(IMPERSONATION_MAX_MINUTES).default(60) }).strict();
const priceB = z.object({ cycle: z.enum(BILLING_CYCLES), pricePaise: z.number().int().min(0).max(1e11), effectiveFrom: isoDate, notes: z.string().max(300).optional(), unverified: z.boolean().optional() }).strict();
const auditQ = z.object({ tenantId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).strict();
const meta = (req: Request) => ({ ip: req.ip ?? null, userAgent: req.headers['user-agent'] });

/**
 * Super-admin console API (M22). Every route except login is @PlatformRoute: platform tokens only (password + TOTP), and
 * every action lands in the hash-chained platform audit log (D178, D179).
 */
@Controller('platform')
@PlatformRoute()
export class PlatformController {
  constructor(private auth: PlatformAuthService, private saas: SaasService, private imp: ImpersonationService, private paudit: PlatformAuditService, private clock: Clock) {}

  @Public() @Throttle({ default: { limit: Number(process.env.AUTH_RATE_LIMIT ?? 10), ttl: 60_000 } }) @Post('auth/login') @HttpCode(200)
  login(@Body(new ZodPipe(loginB)) b: z.infer<typeof loginB>, @Req() req: Request) { return this.auth.login(b.email, b.password, b.totp, meta(req)); }

  @Post('auth/logout') @HttpCode(204)
  async logout(@CurrentPlatform() p: PlatformActor) { await this.auth.logout(p); }

  @Get('me')
  me(@CurrentPlatform() p: PlatformActor) { return { adminId: p.adminId, email: p.email, name: p.name }; }

  @Get('tenants')
  tenants(@Query(new ZodPipe(listQ)) q: z.infer<typeof listQ>) { return this.saas.listTenants(q); }

  @Get('tenants/:id')
  tenant(@CurrentPlatform() p: PlatformActor, @Param('id', uuid) id: string) { return this.saas.tenantDetail(p, id); }

  @Post('tenants/:id/suspend') @HttpCode(200)
  suspend(@CurrentPlatform() p: PlatformActor, @Param('id', uuid) id: string, @Body(new ZodPipe(suspendB)) b: z.infer<typeof suspendB>) { return this.saas.setSuspended(p, id, true, b.reason); }

  @Post('tenants/:id/reactivate') @HttpCode(200)
  reactivate(@CurrentPlatform() p: PlatformActor, @Param('id', uuid) id: string) { return this.saas.setSuspended(p, id, false, null); }

  @Put('tenants/:id/flags')
  flags(@CurrentPlatform() p: PlatformActor, @Param('id', uuid) id: string, @Body(new ZodPipe(flagsB)) b: z.infer<typeof flagsB>) { return this.saas.setFlags(p, id, b.overrides); }

  @Put('tenants/:id/plan')
  plan(@CurrentPlatform() p: PlatformActor, @Param('id', uuid) id: string, @Body(new ZodPipe(planB)) b: z.infer<typeof planB>) { return this.saas.assignPlan(p, id, b); }

  /** Runs the daily lifecycle now (ops). `today` overrides the date only outside production (testing the state machine). */
  @Post('tenants/:id/lifecycle/run') @HttpCode(200)
  async run(@CurrentPlatform() p: PlatformActor, @Param('id', uuid) id: string, @Body(new ZodPipe(runB)) b: z.infer<typeof runB>) {
    if (b.today && process.env.NODE_ENV === 'production') throw new ForbiddenException('today override is not available in production');
    const r = await this.saas.runDaily(id, b.today ?? this.clock.todayIst(), p);
    await this.paudit.record({ adminId: p.adminId, tenantId: id, action: 'platform.lifecycle_run', entity: 'tenant', entityId: id, diff: { today: r.today, status: r.status }, ip: p.ip });
    return r;
  }

  @Post('tenants/:id/meter') @HttpCode(200)
  async meter(@CurrentPlatform() p: PlatformActor, @Param('id', uuid) id: string) {
    const r = await this.saas.meter(id);
    await this.paudit.record({ adminId: p.adminId, tenantId: id, action: 'platform.metered', entity: 'tenant', entityId: id, ip: p.ip });
    return r;
  }

  @Post('tenants/:id/invoices/:invoiceId/mark-paid') @HttpCode(200)
  markPaid(@CurrentPlatform() p: PlatformActor, @Param('id', uuid) id: string, @Param('invoiceId', uuid) inv: string) { return this.saas.adminMarkPaid(p, id, inv); }

  @Get('tenants/:id/impersonations')
  impersonations(@Param('id', uuid) id: string) { return this.imp.listPlatform(id); }

  @Post('tenants/:id/impersonations')
  requestImp(@CurrentPlatform() p: PlatformActor, @Param('id', uuid) id: string, @Body(new ZodPipe(impB)) b: z.infer<typeof impB>) { return this.imp.request(p, id, b); }

  @Post('tenants/:id/impersonations/:grantId/start') @HttpCode(200)
  start(@CurrentPlatform() p: PlatformActor, @Param('id', uuid) id: string, @Param('grantId', uuid) g: string) { return this.imp.start(p, id, g); }

  @Post('tenants/:id/impersonations/:grantId/end') @HttpCode(200)
  end(@CurrentPlatform() p: PlatformActor, @Param('id', uuid) id: string, @Param('grantId', uuid) g: string) { return this.imp.revoke(null, g, id, p); }

  @Get('plans')
  plans() { return this.saas.listPlans(); }

  @Put('plans/:key')
  savePlan(@CurrentPlatform() p: PlatformActor, @Param('key', new ZodPipe(z.string().regex(/^[a-z][a-z0-9_]{1,30}$/))) key: string,
    @Body(new ZodPipe(planSchema.omit({ key: true }).extend({ active: z.boolean().optional() }).strict())) b: Omit<z.infer<typeof planSchema>, 'key'> & { active?: boolean }) {
    return this.saas.upsertPlan(p, { ...b, key });
  }

  @Post('plans/:key/prices')
  addPrice(@CurrentPlatform() p: PlatformActor, @Param('key', new ZodPipe(z.string().max(31))) key: string, @Body(new ZodPipe(priceB)) b: z.infer<typeof priceB>) { return this.saas.addPrice(p, key, b); }

  @Get('audit')
  audit(@Query(new ZodPipe(auditQ)) q: z.infer<typeof auditQ>) { return this.paudit.list(q); }

  @Get('audit/verify')
  verify() { return this.paudit.verify(); }
}

/** SaaS payment webhooks (signature-verified per provider; no tenant in the URL — the link id maps to it). */
@Controller('saas')
export class SaasWebhookController {
  constructor(private saas: SaasService) {}

  @Public() @Throttle({ default: { limit: 120, ttl: 60_000 } }) @Post('webhooks/:provider') @HttpCode(200)
  webhook(@Param('provider', new ZodPipe(z.enum(['mock', 'razorpay']))) provider: string, @Req() req: Request & { rawBody?: Buffer }) {
    return this.saas.webhook(provider, req.rawBody, req.headers);
  }
}

const upgradeB = z.object({ planKey: z.string().max(31), cycle: z.enum(BILLING_CYCLES), note: z.string().trim().max(1000).optional() }).strict();
const approveB = z.object({ writeConsent: z.boolean().default(false), minutes: z.number().int().min(5).max(IMPERSONATION_MAX_MINUTES).optional() }).strict();

/** Firm side: Settings → Subscription (plan, seats, usage, invoices, upgrade requests) and support-access consent. */
@Controller()
export class SubscriptionController {
  constructor(private saas: SaasService, private imp: ImpersonationService) {}

  @Get('subscription') @Perm('settings', 'view')
  get(@CurrentActor() a: RequestActor) { return this.saas.subscription(a); }

  @Post('subscription/upgrade-requests') @Perm('settings', 'edit')
  upgrade(@CurrentActor() a: RequestActor, @Body(new ZodPipe(upgradeB)) b: z.infer<typeof upgradeB>) { return this.saas.requestUpgrade(a, b); }

  @Get('impersonation/grants') @Perm('settings', 'view')
  grants(@CurrentActor() a: RequestActor) { return this.imp.list(a); }

  @Post('impersonation/grants/:id/approve') @HttpCode(200) @Perm('settings', 'view')
  approve(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string, @Body(new ZodPipe(approveB)) b: z.infer<typeof approveB>) { return this.imp.decide(a, id, 'approve', b); }

  @Post('impersonation/grants/:id/deny') @HttpCode(200) @Perm('settings', 'view')
  deny(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string) { return this.imp.decide(a, id, 'deny'); }

  @Post('impersonation/grants/:id/revoke') @HttpCode(200) @Perm('settings', 'view')
  revoke(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string) {
    if (!a.roles.some((r) => r.key === 'partner') && effectiveScope(a, 'settings', 'edit')?.scope !== 'all') throw new ForbiddenException('Only partners or firm settings editors can revoke');
    return this.imp.revoke(a, id, a.tenantId);
  }
}
