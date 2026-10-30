import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { DATA_CATEGORIES, DPDP_REQUEST_KINDS, DPDP_REQUEST_STATUSES, PRINCIPAL_TYPES, RETENTION_KEYS, retentionPolicySchema } from '@worko/domain';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentActor, CurrentPortal, Feature, Perm, PortalAllowed, Public, type PortalActor, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DpdpService } from './dpdp.service.js';

const uuid = new ParseUUIDPipe();
const ts = z.string().datetime({ offset: true });
const settingsB = z.object({ settings: z.unknown().optional(), retention: z.record(z.enum(RETENTION_KEYS), retentionPolicySchema).optional() }).strict();
const createB = z.object({ kind: z.enum(DPDP_REQUEST_KINDS), principalType: z.enum(PRINCIPAL_TYPES), principalId: z.string().uuid(), details: z.string().trim().max(5000).optional() }).strict();
const listQ = z.object({ status: z.enum(DPDP_REQUEST_STATUSES).optional(), overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }).strict();
const updateB = z.object({ status: z.enum(DPDP_REQUEST_STATUSES).optional(), assignedTo: z.string().uuid().nullable().optional(), resolution: z.string().trim().max(5000).optional() }).strict();
const eraseB = z.object({ dryRun: z.boolean().default(true) }).strict();
const breachB = z.object({ title: z.string().trim().min(3).max(200), description: z.string().trim().max(10000).optional(), severity: z.enum(['low', 'medium', 'high', 'critical']),
  occurredAt: ts.optional(), awareAt: ts, affectedCount: z.number().int().min(0).max(1e9), dataCategories: z.array(z.enum(DATA_CATEGORIES)).max(20).default([]) }).strict();
const breachU = z.object({ status: z.enum(['open', 'contained', 'closed']).optional(), affectedCount: z.number().int().min(0).max(1e9).optional(),
  boardNotifiedAt: ts.nullable().optional(), principalsNotifiedAt: ts.nullable().optional(), principalsNotifiedCount: z.number().int().min(0).max(1e9).optional() }).strict();
const purgeB = z.object({ dryRun: z.boolean().default(true) }).strict();
const consentQ = z.object({ clientId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).strict();
const portalB = z.object({ kind: z.enum(DPDP_REQUEST_KINDS), clientId: z.string().uuid().optional(), details: z.string().trim().max(5000).optional() }).strict();

/** Settings → Privacy (DPDP tooling). Reads need settings:view; changes need firm-wide settings:edit, erasure/purge settings:approve, export settings:export. */
@Controller('privacy')
export class DpdpController {
  constructor(private dpdp: DpdpService) {}

  @Get('inventory') @Perm('settings', 'view')
  inventory(@CurrentActor() a: RequestActor) { return this.dpdp.inventory(a); }

  @Get('settings') @Perm('settings', 'view')
  settings(@CurrentActor() a: RequestActor) { return this.dpdp.getSettings(a); }

  @Put('settings') @Perm('settings', 'edit')
  putSettings(@CurrentActor() a: RequestActor, @Body(new ZodPipe(settingsB)) b: z.infer<typeof settingsB>) { return this.dpdp.putSettings(a, b); }

  @Get('consents') @Perm('settings', 'view')
  consents(@CurrentActor() a: RequestActor, @Query(new ZodPipe(consentQ)) q: z.infer<typeof consentQ>) { return this.dpdp.consents(a, q); }

  @Get('requests') @Perm('settings', 'view')
  requests(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listQ)) q: z.infer<typeof listQ>) { return this.dpdp.listRequests(a, q); }

  @Post('requests') @Perm('settings', 'edit')
  create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(createB)) b: z.infer<typeof createB>) { return this.dpdp.createRequest(a, b); }

  @Patch('requests/:id') @Perm('settings', 'edit')
  update(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string, @Body(new ZodPipe(updateB)) b: z.infer<typeof updateB>) { return this.dpdp.updateRequest(a, id, b); }

  @Post('requests/:id/export') @HttpCode(200) @Perm('settings', 'export')
  export(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string) { return this.dpdp.export(a, id); }

  @Post('requests/:id/erase') @HttpCode(200) @Perm('settings', 'approve')
  erase(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string, @Body(new ZodPipe(eraseB)) b: z.infer<typeof eraseB>) { return this.dpdp.erase(a, id, b); }

  @Get('breaches') @Perm('settings', 'view')
  breaches(@CurrentActor() a: RequestActor) { return this.dpdp.listBreaches(a); }

  @Post('breaches') @Perm('settings', 'edit')
  createBreach(@CurrentActor() a: RequestActor, @Body(new ZodPipe(breachB)) b: z.infer<typeof breachB>) { return this.dpdp.createBreach(a, b); }

  @Patch('breaches/:id') @Perm('settings', 'edit')
  updateBreach(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string, @Body(new ZodPipe(breachU)) b: z.infer<typeof breachU>) { return this.dpdp.updateBreach(a, id, b); }

  @Post('purge') @HttpCode(200) @Perm('settings', 'approve')
  purge(@CurrentActor() a: RequestActor, @Body(new ZodPipe(purgeB)) b: z.infer<typeof purgeB>) { return this.dpdp.purge(a, b); }

  @Get('purge-runs') @Perm('settings', 'view')
  purgeRuns(@CurrentActor() a: RequestActor) { return this.dpdp.purgeRuns(a); }

  /** Expiring access-request bundle (random token, sha256 stored; 410 after expiry). */
  @Public() @Throttle({ default: { limit: 30, ttl: 60_000 } }) @Get('exports/:token')
  async download(@Param('token', new ZodPipe(z.string().min(20).max(100))) token: string, @Res() res: Response) {
    const body = await this.dpdp.download(token);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="personal-data.json"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(body);
  }
}

/** Client portal: data-principal requests about yourself or a client you can access. */
@Controller('portal/privacy-requests')
@Feature('portal')
export class PortalPrivacyController {
  constructor(private dpdp: DpdpService) {}

  @Get() @PortalAllowed()
  list(@CurrentPortal() p: PortalActor) { return this.dpdp.portalList(p); }

  @Post() @PortalAllowed()
  create(@CurrentPortal() p: PortalActor, @Body(new ZodPipe(portalB)) b: z.infer<typeof portalB>) { return this.dpdp.portalCreate(p, b); }
}
