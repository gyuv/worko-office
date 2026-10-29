import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { COMM_CHANNELS, ENTITY_TYPES, gstinSchema, LEAD_ACTIVITY_KINDS, LEAD_SOURCES, LEAD_STAGES, panSchema, PROPOSAL_FREQUENCIES, PROPOSAL_STATUSES } from '@worko/domain';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentActor, Perm, Public, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { LeadsService } from './leads.service.js';
import { ProposalsService } from './proposals.service.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');
const paise = z.number().int().min(0).max(1e13);
const opt = <T extends z.ZodTypeAny>(t: T) => t.nullable().optional();
const leadFields = {
  name: z.string().trim().min(1).max(200), company: opt(z.string().trim().max(200)), email: opt(z.string().trim().email().max(200)), phone: opt(z.string().regex(/^\+?[\d\s-]{10,18}$/)),
  pan: opt(panSchema), gstin: opt(gstinSchema), entityType: opt(z.enum(ENTITY_TYPES)), stateCode: opt(z.string().regex(/^\d{2}$/)), source: z.enum(LEAD_SOURCES).optional(),
  ownerId: opt(z.string().uuid()), expectedValuePaise: paise.optional(), nextFollowupOn: opt(date), notes: opt(z.string().max(5000)),
};
const leadB = z.object(leadFields).strict();
const leadPatchB = z.object(leadFields).partial().strict();
const moveB = z.object({ stage: z.enum(LEAD_STAGES), beforeId: opt(z.string().uuid()), afterId: opt(z.string().uuid()), lostReason: opt(z.string().trim().min(2).max(500)) }).strict();
const listQ = z.object({ stage: z.enum(LEAD_STAGES).optional(), ownerId: z.string().uuid().optional(), q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) });
const dupQ = z.object({ pan: z.string().max(10).optional(), gstin: z.string().max(15).optional(), email: z.string().max(200).optional(), phone: z.string().max(20).optional() });
const actB = z.object({ kind: z.enum(LEAD_ACTIVITY_KINDS), body: z.string().trim().min(1).max(5000), at: opt(z.string().datetime({ offset: true })) }).strict();
const lineB = z.object({
  serviceTypeId: opt(z.string().uuid()), description: opt(z.string().trim().max(500)), frequency: z.enum(PROPOSAL_FREQUENCIES), qty: z.number().positive().max(10_000).multipleOf(0.01).optional(),
  feePaise: paise.nullable().optional(), gstRate: z.number().min(0).max(28).nullable().optional(), discountPaise: paise.optional(),
}).strict().refine((l) => l.serviceTypeId || (l.description && l.feePaise != null), 'A free line needs a description and a fee');
const proposalFields = {
  title: z.string().trim().min(1).max(200), entityId: opt(z.string().uuid()), placeOfSupply: opt(z.string().regex(/^\d{2}$/)),
  lines: z.array(lineB).min(1).max(100), terms: opt(z.string().max(10_000)), validUntil: opt(date),
};
const proposalB = z.object(proposalFields).strict();
const proposalPatchB = z.object(proposalFields).partial().strict();
const sendB = z.object({ channel: z.enum(COMM_CHANNELS), templateId: opt(z.string().uuid()) }).strict();
const convertB = z.object({
  clientId: opt(z.string().uuid()), ignoreDuplicates: z.boolean().optional(), entityType: opt(z.enum(ENTITY_TYPES)), startPeriod: opt(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)),
  inviteToPortal: z.boolean().optional(), sendForEsign: z.boolean().optional(), portalGrants: z.any().optional(),
}).strict();
const token = new ZodPipe(z.string().min(20).max(1000));
const PUBLIC_LIMIT = { default: { limit: Number(process.env.PUBLIC_PAGE_RATE_LIMIT ?? 20), ttl: 60_000 } };
const uuid = new ParseUUIDPipe();

@Controller('leads')
export class LeadsController {
  constructor(private leads: LeadsService, private proposals: ProposalsService) {}

  @Get() @Perm('leads', 'view') list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listQ)) q: z.infer<typeof listQ>) { return this.leads.list(a, q); }
  @Post() @Perm('leads', 'create') create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(leadB)) b: z.infer<typeof leadB>) { return this.leads.create(a, b); }
  @Get('board') @Perm('leads', 'view') board(@CurrentActor() a: RequestActor) { return this.leads.board(a); }
  @Get('duplicates') @Perm('leads', 'view') dup(@CurrentActor() a: RequestActor, @Query(new ZodPipe(dupQ)) q: z.infer<typeof dupQ>) { return this.leads.duplicates(a, q); }
  @Get('settings') @Perm('leads', 'view') settings(@CurrentActor() a: RequestActor) { return this.leads.settings(a); }
  @Put('settings') @Perm('settings', 'edit') putSettings(@CurrentActor() a: RequestActor, @Body() b: unknown) { return this.leads.putSettings(a, b); }
  @Get(':id') @Perm('leads', 'view') get(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string) { return this.leads.get(a, id); }
  @Patch(':id') @HttpCode(204) @Perm('leads', 'edit')
  async update(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string, @Body(new ZodPipe(leadPatchB)) b: z.infer<typeof leadPatchB>) { await this.leads.update(a, id, b as never); }
  @Delete(':id') @HttpCode(204) @Perm('leads', 'delete') async remove(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string) { await this.leads.remove(a, id); }
  @Post(':id/move') @HttpCode(200) @Perm('leads', 'edit') move(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string, @Body(new ZodPipe(moveB)) b: z.infer<typeof moveB>) { return this.leads.move(a, id, b); }
  @Get(':id/activities') @Perm('leads', 'view') acts(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string) { return this.leads.activities(a, id); }
  @Post(':id/activities') @Perm('leads', 'edit') addAct(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string, @Body(new ZodPipe(actB)) b: z.infer<typeof actB>) { return this.leads.addActivity(a, id, b); }
  @Post(':id/proposals') @Perm('leads', 'create')
  propose(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string, @Body(new ZodPipe(proposalB)) b: z.infer<typeof proposalB>) { return this.proposals.create(a, id, b as never); }
}

@Controller('proposals')
export class ProposalsController {
  constructor(private proposals: ProposalsService) {}

  @Get() @Perm('leads', 'view')
  list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ leadId: z.string().uuid().optional(), status: z.enum(PROPOSAL_STATUSES).optional() }))) q: { leadId?: string; status?: (typeof PROPOSAL_STATUSES)[number] }) {
    return this.proposals.list(a, q);
  }
  @Get(':id') @Perm('leads', 'view') get(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string) { return this.proposals.get(a, id); }
  @Patch(':id') @Perm('leads', 'edit') update(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string, @Body(new ZodPipe(proposalPatchB)) b: z.infer<typeof proposalPatchB>) { return this.proposals.update(a, id, b as never); }
  @Get(':id/diff') @Perm('leads', 'view')
  diff(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string, @Query(new ZodPipe(z.object({ from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1) }))) q: { from: number; to: number }) {
    return this.proposals.diff(a, id, q.from, q.to);
  }
  @Post(':id/send') @HttpCode(200) @Perm('leads', 'edit') send(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string, @Body(new ZodPipe(sendB)) b: z.infer<typeof sendB>) { return this.proposals.send(a, id, b); }
  @Post(':id/withdraw') @HttpCode(204) @Perm('leads', 'edit') async withdraw(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string) { await this.proposals.withdraw(a, id); }
  @Post(':id/convert') @HttpCode(200) @Perm('leads', 'approve')
  convert(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string, @Body(new ZodPipe(convertB)) b: z.infer<typeof convertB>) { return this.proposals.convert(a, id, b as never); }

  // ---------- Public e-accept page (signed link; rate-limited per IP) ----------
  @Public() @Throttle(PUBLIC_LIMIT) @Get('public/:token') view(@Param('token', token) t: string) { return this.proposals.publicView(t); }
  @Public() @Throttle(PUBLIC_LIMIT) @Post('public/:token/accept') @HttpCode(200)
  accept(@Param('token', token) t: string, @Body(new ZodPipe(z.object({ name: z.string().trim().min(2).max(200), agree: z.literal(true) }).strict())) b: { name: string }, @Req() req: Request) {
    return this.proposals.decide(t, { accept: true, name: b.name }, { ip: req.ip ?? null, userAgent: req.headers['user-agent'] });
  }
  @Public() @Throttle(PUBLIC_LIMIT) @Post('public/:token/decline') @HttpCode(200)
  decline(@Param('token', token) t: string, @Body(new ZodPipe(z.object({ reason: z.string().trim().min(2).max(1000) }).strict())) b: { reason: string }, @Req() req: Request) {
    return this.proposals.decide(t, { accept: false, reason: b.reason }, { ip: req.ip ?? null, userAgent: req.headers['user-agent'] });
  }
}
