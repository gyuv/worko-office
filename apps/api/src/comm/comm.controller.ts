import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { COMM_CHANNELS, ENTITY_TYPES, TEMPLATE_CATEGORIES, TEMPLATE_STATUSES, TIMELINE_CHANNELS } from '@worko/domain';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentActor, Perm, Public, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { BroadcastService } from './broadcast.service.js';
import { CommService } from './comm.service.js';
import { ConnectionsService } from './connections.service.js';

const channel = z.enum(COMM_CHANNELS);
const category = z.enum(TEMPLATE_CATEGORIES);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');
const iso = z.string().datetime({ offset: true });
const vars = z.record(z.string().max(100), z.string().max(500)).refine((v) => Object.keys(v).length <= 30, 'Too many variables');
const templateB = z.object({
  name: z.string().regex(/^[a-z0-9_]{2,60}$/), channel, category, language: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/).optional(),
  subject: z.string().trim().max(300).nullable().optional(), body: z.string().trim().min(1).max(4096), sensitive: z.boolean().optional(), dltTemplateId: z.string().regex(/^\d{10,25}$/).nullable().optional(),
}).strict();
const templatePatchB = templateB.omit({ name: true, channel: true }).partial().strict();
const sendB = z.object({
  clientId: z.string().uuid(), channel, contactId: z.string().uuid().nullable().optional(), address: z.string().max(254).nullable().optional(),
  templateId: z.string().uuid().nullable().optional(), vars: vars.optional(), subject: z.string().trim().max(300).nullable().optional(), body: z.string().max(4096).nullable().optional(), category: category.optional(),
}).strict();
const consentB = z.object({ clientId: z.string().uuid(), channel, contactId: z.string().uuid().nullable().optional(), address: z.string().max(254).nullable().optional(),
  status: z.enum(['opted_in', 'opted_out']), source: z.enum(['verbal', 'written', 'form', 'email', 'whatsapp', 'other']), note: z.string().max(500).nullable().optional() }).strict();
const rateB = z.object({ channel, category: z.enum([...TEMPLATE_CATEGORIES, '*']), paise: z.number().int().min(0).max(1_000_000), effectiveFrom: date, note: z.string().max(300).nullable().optional() }).strict();
const filtersB = z.object({
  groupIds: z.array(z.string().uuid()).max(50).optional(), tags: z.array(z.string().max(50)).max(30).optional(), serviceTypeIds: z.array(z.string().uuid()).max(50).optional(),
  entityTypes: z.array(z.enum(ENTITY_TYPES)).max(20).optional(), clientIds: z.array(z.string().uuid()).max(5000).optional(), includeInactive: z.boolean().optional(),
}).strict();
const broadcastB = z.object({ name: z.string().trim().min(1).max(200), channel, templateId: z.string().uuid(), filters: filtersB, variables: vars.optional(), scheduledAt: iso.nullable().optional() }).strict();
const logB = z.object({ channel: z.enum(['note', 'call']), body: z.string().trim().min(1).max(10_000), subject: z.string().max(300).nullable().optional(), direction: z.enum(['in', 'out']).optional(),
  callMinutes: z.number().int().min(0).max(1440).nullable().optional(), occurredAt: iso.nullable().optional() }).strict();
const timelineQ = z.object({ before: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), channel: z.enum([...TIMELINE_CHANNELS, 'events']).optional() });

@Controller('comm')
export class CommController {
  constructor(private comm: CommService, private broadcasts: BroadcastService, private connections: ConnectionsService) {}

  @Get('settings') @Perm('communication', 'view') settings(@CurrentActor() a: RequestActor) { return this.comm.settings(a); }
  @Put('settings') @Perm('settings', 'edit') putSettings(@CurrentActor() a: RequestActor, @Body() b: unknown) { return this.comm.putSettings(a, b); }
  @Get('rates') @Perm('communication', 'view') rates(@CurrentActor() a: RequestActor) { return this.comm.rates(a); }
  @Post('rates') @Perm('settings', 'edit') addRate(@CurrentActor() a: RequestActor, @Body(new ZodPipe(rateB)) b: z.infer<typeof rateB>) { return this.comm.addRate(a, b); }
  @Get('usage') @Perm('communication', 'view')
  usage(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }))) q: { month: string }) { return this.comm.usage(a, q.month); }

  @Get('templates') @Perm('communication', 'view')
  templates(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ channel: channel.optional(), status: z.enum(TEMPLATE_STATUSES).optional() }))) q: { channel?: 'email'; status?: string }) { return this.comm.templates(a, q); }
  @Post('templates') @Perm('communication', 'create') createTemplate(@CurrentActor() a: RequestActor, @Body(new ZodPipe(templateB)) b: z.infer<typeof templateB>) { return this.comm.createTemplate(a, b); }
  @Patch('templates/:id') @Perm('communication', 'edit')
  updateTemplate(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(templatePatchB)) b: z.infer<typeof templatePatchB>) { return this.comm.updateTemplate(a, id, b); }
  @Post('templates/:id/submit') @HttpCode(200) @Perm('communication', 'edit') submitTemplate(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.comm.submitTemplate(a, id); }
  @Post('templates/:id/decide') @HttpCode(200) @Perm('communication', 'approve')
  decideTemplate(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ approve: z.boolean(), reason: z.string().max(500).nullable().optional() }).strict())) b: { approve: boolean; reason?: string | null }) { return this.comm.decideTemplate(a, id, b); }
  @Post('templates/:id/render') @HttpCode(200) @Perm('communication', 'view')
  render(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ clientId: z.string().uuid().nullable().optional(), vars: vars.optional() }).strict())) b: { clientId?: string | null; vars?: Record<string, string> }) { return this.comm.renderPreview(a, id, b); }

  @Get('consents') @Perm('communication', 'view')
  consents(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ clientId: z.string().uuid().optional(), address: z.string().max(254).optional() }))) q: { clientId?: string; address?: string }) { return this.comm.consents(a, q); }
  @Post('consents') @Perm('communication', 'edit') recordConsent(@CurrentActor() a: RequestActor, @Body(new ZodPipe(consentB)) b: z.infer<typeof consentB>) { return this.comm.recordConsent(a, b); }

  @Post('messages') @Perm('communication', 'create') send(@CurrentActor() a: RequestActor, @Body(new ZodPipe(sendB)) b: z.infer<typeof sendB>) { return this.comm.send(a, b); }
  @Get('inbox') @Perm('communication', 'assign') inbox(@CurrentActor() a: RequestActor) { return this.comm.inbox(a); }
  @Post('inbox/:id/assign') @HttpCode(200) @Perm('communication', 'assign')
  assign(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ clientId: z.string().uuid(), contactId: z.string().uuid().nullable().optional() }).strict())) b: { clientId: string; contactId?: string | null }) { return this.comm.assignInbound(a, id, b); }

  @Get('broadcasts') @Perm('communication', 'view') listBroadcasts(@CurrentActor() a: RequestActor) { return this.broadcasts.list(a); }
  @Post('broadcasts') @Perm('communication', 'create') createBroadcast(@CurrentActor() a: RequestActor, @Body(new ZodPipe(broadcastB)) b: z.infer<typeof broadcastB>) { return this.broadcasts.create(a, b); }
  @Get('broadcasts/:id') @Perm('communication', 'view') getBroadcast(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.broadcasts.get(a, id); }
  @Post('broadcasts/:id/preview') @HttpCode(200) @Perm('communication', 'view') preview(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.broadcasts.preview(a, id); }
  @Post('broadcasts/:id/send') @HttpCode(200) @Perm('communication', 'create')
  sendBroadcast(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ scheduledAt: iso.nullable().optional() }).strict())) b: { scheduledAt?: string | null }) { return this.broadcasts.send(a, id, b); }
  @Post('broadcasts/:id/approve') @HttpCode(200) @Perm('communication', 'approve') approve(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.broadcasts.approve(a, id); }
  @Post('broadcasts/:id/cancel') @HttpCode(200) @Perm('communication', 'edit') cancel(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.broadcasts.cancel(a, id); }
  @Get('broadcasts/:id/recipients') @Perm('communication', 'view')
  recipients(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(z.object({ status: z.string().max(30).optional() }))) q: { status?: string }) { return this.broadcasts.recipients(a, id, q); }
  @Get('broadcasts/:id/export') @Perm('communication', 'export')
  async export(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const f = await this.broadcasts.export(a, id);
    res.setHeader('Content-Type', f.mime); res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
    return new StreamableFile(f.body);
  }

  @Get('connections') @Perm('communication', 'view') connectionsList(@CurrentActor() a: RequestActor) { return this.connections.list(a); }
  @Post('connections') @Perm('communication', 'create')
  connect(@CurrentActor() a: RequestActor, @Body(new ZodPipe(z.object({ provider: z.enum(['mock', 'google', 'microsoft']), purpose: z.enum(['mail', 'calendar']) }).strict())) b: { provider: 'mock'; purpose: 'mail' }) { return this.connections.start(a, b); }
  @Delete('connections/:id') @HttpCode(204) @Perm('communication', 'view') disconnect(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.connections.revoke(a, id); }
  @Post('connections/:id/sync') @HttpCode(200) @Perm('communication', 'view') syncConnection(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.connections.syncNow(a, id); }
  /** OAuth redirect target (public by necessity; the single-use state authenticates it). */
  @Get('oauth/callback') @Public() @Throttle({ default: { limit: 30, ttl: 60_000 } })
  callback(@Query(new ZodPipe(z.object({ state: z.string().max(300).optional(), code: z.string().max(2000).optional(), error: z.string().max(200).optional() }))) q: { state?: string; code?: string; error?: string }) { return this.connections.callback(q); }

  // ---------- Public provider webhooks ----------
  @Get('webhooks/:provider/:tenantId') @Public() @Header('Content-Type', 'text/plain')
  challenge(@Param('provider', new ZodPipe(z.enum(['mock', 'meta']))) provider: string, @Query() q: Record<string, string | undefined>) { return this.comm.challenge(provider, q); }
  @Post('webhooks/:provider/:tenantId') @HttpCode(200) @Public()
  webhook(@Param('provider', new ZodPipe(z.enum(['mock', 'meta']))) provider: string, @Param('tenantId') tenantId: string, @Req() req: Request & { rawBody?: Buffer }) {
    return this.comm.webhook(provider, tenantId, req.rawBody, req.headers);
  }
}

@Controller('clients/:id/timeline')
export class TimelineController {
  constructor(private comm: CommService) {}
  @Get() @Perm('communication', 'view')
  timeline(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(timelineQ)) q: z.infer<typeof timelineQ>) { return this.comm.timeline(a, id, q); }
  @Post() @Perm('communication', 'create')
  log(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(logB)) b: z.infer<typeof logB>) { return this.comm.logActivity(a, id, b); }
}
