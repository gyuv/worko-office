import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { NOTICE_AUTHORITY_KEYS, NOTICE_OUTCOMES, NOTICE_STATUSES, SIGNOFF_LEVELS, udinSchema } from '@worko/domain';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentActor, Perm, Public, type RequestActor, Feature } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { MAX_UPLOAD } from '../documents/documents.service.js';
import { AuditWorkService } from './audit.service.js';
import { isoDate, SECRET_TEXT_RX } from './common.js';
import { httpsUrl, noticeFields } from './schemas.js';
import { DscService, SECRET_KEY_RX } from './dsc.service.js';
import { EsignService } from './esign.service.js';
import { NoticesService } from './notices.service.js';
import { PracticeService } from './practice.service.js';
import { udinPortalUrl } from './udin-gate.js';

const uuid = z.string().uuid();
const txt = (n = 200) => z.string().trim().min(1).max(n);
const opt = (n = 200) => z.string().trim().max(n).nullable().optional();
const paise = z.number().int().min(0).max(1e15);
const page = { limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) };
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const yearRange = z.string().regex(/^\d{4}-\d{2}$/);

// ---------- Notices ----------
const noticeIn = z.object({ clientId: uuid, ...noticeFields, createTask: z.boolean().optional(), appealOf: uuid.nullable().optional() }).strict();
const noticePatch = z.object(noticeFields).partial().strict();
const noticeListQ = z.object({ clientId: uuid.optional(), status: z.string().transform((s) => s.split(',')).pipe(z.array(z.enum(NOTICE_STATUSES))).optional(),
  authority: z.enum(NOTICE_AUTHORITY_KEYS).optional(), open: bool.optional(), overdue: bool.optional(), assigneeId: z.union([uuid, z.literal('me')]).optional(), q: z.string().max(100).optional(), ...page });
const statusIn = z.object({ status: z.enum(NOTICE_STATUSES), outcome: z.enum(NOTICE_OUTCOMES).nullable().optional(), outcomeNote: opt(2000), finalDemandPaise: paise.nullable().optional() }).strict();
const linkDocIn = z.object({ documentId: uuid, kind: z.enum(['notice', 'reply', 'order', 'evidence', 'other']) }).strict();
const extractB = z.object({ clientId: uuid, noticeId: uuid.optional() });
const confirmIn = z.object({ fields: z.record(z.union([z.string().max(200), z.number()])), title: txt(300).optional(), level: z.string().max(40).optional(),
  assigneeId: uuid.nullable().optional(), reviewerId: uuid.nullable().optional() }).strict();
const hearingIn = z.object({ startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }).nullable().optional(), venue: opt(300),
  virtualLink: httpsUrl.nullable().optional() }).strict();
const hearingPatch = z.object({ prepDone: z.boolean().optional(), status: z.enum(['held', 'cancelled']).optional(), outcomeNote: opt(2000), venue: opt(300),
  virtualLink: httpsUrl.nullable().optional() }).strict();
const adjournIn = hearingIn.extend({ reason: opt(500) });

@Controller('notices')
export class NoticesController {
  constructor(private notices: NoticesService) {}
  @Get() @Perm('notices', 'view') list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(noticeListQ)) q: z.infer<typeof noticeListQ>) { return this.notices.list(a, q); }
  @Post() @Perm('notices', 'create') create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(noticeIn)) b: z.infer<typeof noticeIn>) { return this.notices.create(a, b); }
  @Get('reports/ageing') @Perm('notices', 'view') ageing(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ asOf: isoDate.optional() }))) q: { asOf?: string }) { return this.notices.ageing(a, q.asOf); }
  @Post('extract') @Perm('notices', 'create') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD, files: 1 } }))
  extract(@CurrentActor() a: RequestActor, @UploadedFile() file: Express.Multer.File, @Body(new ZodPipe(extractB)) b: z.infer<typeof extractB>, @Req() req: Request) {
    return this.notices.extract(a, file, b, req.ip ?? null);
  }
  @Get('extractions/:id') @Perm('notices', 'view') extraction(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.notices.getExtraction(a, id); }
  @Post('extractions/:id/confirm') @Perm('notices', 'create')
  confirm(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(confirmIn)) b: z.infer<typeof confirmIn>) { return this.notices.confirmExtraction(a, id, b); }
  @Post('extractions/:id/discard') @HttpCode(204) @Perm('notices', 'create')
  async discard(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.notices.discardExtraction(a, id); }
  @Patch('hearings/:id') @HttpCode(204) @Perm('notices', 'edit')
  async updateHearing(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(hearingPatch)) b: z.infer<typeof hearingPatch>) { await this.notices.updateHearing(a, id, b); }
  @Post('hearings/:id/adjourn') @Perm('notices', 'edit')
  adjourn(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(adjournIn)) b: z.infer<typeof adjournIn>) { return this.notices.adjourn(a, id, b); }
  @Get(':id') @Perm('notices', 'view') get(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.notices.get(a, id); }
  @Patch(':id') @HttpCode(204) @Perm('notices', 'edit')
  async update(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(noticePatch)) b: z.infer<typeof noticePatch>) { await this.notices.update(a, id, b); }
  @Post(':id/status') @HttpCode(204) @Perm('notices', 'edit')
  async status(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(statusIn)) b: z.infer<typeof statusIn>) { await this.notices.setStatus(a, id, b); }
  @Post(':id/documents') @HttpCode(204) @Perm('notices', 'edit')
  async link(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(linkDocIn)) b: z.infer<typeof linkDocIn>) { await this.notices.linkDocument(a, id, b); }
  @Post(':id/hearings') @Perm('notices', 'edit')
  hearing(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(hearingIn)) b: z.infer<typeof hearingIn>) { return this.notices.addHearing(a, id, b); }
}

// ---------- Audit workpapers & UDIN ----------
const procIn = z.object({ key: z.string().regex(/^[a-z0-9_]{1,40}$/), title: txt(300), evidence: z.array(txt(200)).max(20).default([]) });
const sectionIn = z.object({ key: z.string().regex(/^[a-z0-9_]{1,40}$/), title: txt(200), procedures: z.array(procIn).max(200) });
const auditType = z.string().regex(/^[a-z0-9_]{2,40}$/);
const programmeIn = z.object({ name: txt(200), auditType, sections: z.array(sectionIn).min(1).max(50), udinRequired: z.boolean().optional() }).strict();
const programmePatch = z.object({ name: txt(200).optional(), sections: z.array(sectionIn).min(1).max(50).optional(), active: z.boolean().optional(), udinRequired: z.boolean().optional() }).strict();
const engagementIn = z.object({ clientId: uuid, fy: yearRange, auditType, programmeId: uuid.nullable().optional(), partnerId: uuid.nullable().optional(), managerId: uuid.nullable().optional(),
  taskId: uuid.nullable().optional(), createTask: z.boolean().optional(), udinRequired: z.boolean().optional(), reportDue: isoDate.nullable().optional() }).strict();
const engagementPatch = z.object({ status: z.enum(['planning', 'fieldwork', 'review', 'closed']).optional(), partnerId: uuid.nullable().optional(), managerId: uuid.nullable().optional() }).strict();
const engListQ = z.object({ clientId: uuid.optional(), fy: yearRange.optional(), status: z.string().max(20).optional(), ...page });
const pbcIn = z.object({ items: z.array(z.object({ title: txt(300), description: opt(2000), dueDate: isoDate.nullable().optional() }).strict()).min(1).max(200) }).strict();
const pbcPatch = z.object({ status: z.enum(['requested', 'received', 'accepted', 'rejected']).optional(), documentIds: z.array(uuid).max(50).optional(), rejectionReason: opt(1000),
  dueDate: isoDate.nullable().optional() }).strict();
const udinIn = z.object({ clientId: uuid, engagementId: uuid.nullable().optional(), taskId: uuid.nullable().optional(), udin: udinSchema, documentType: txt(100), generatedOn: isoDate,
  membershipNo: z.string().regex(/^\d{6}$/), signingPartnerId: uuid.nullable().optional(), documentId: uuid.nullable().optional() }).strict();

@Controller('audit')
export class AuditWorkController {
  constructor(private work: AuditWorkService) {}
  @Get('programmes') @Perm('audit', 'view') programmes(@CurrentActor() a: RequestActor) { return this.work.programmes(a); }
  @Post('programmes') @Perm('audit', 'create') createProgramme(@CurrentActor() a: RequestActor, @Body(new ZodPipe(programmeIn)) b: z.infer<typeof programmeIn>) { return this.work.createProgramme(a, b); }
  @Patch('programmes/:id') @HttpCode(204) @Perm('audit', 'edit')
  async updateProgramme(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(programmePatch)) b: z.infer<typeof programmePatch>) { await this.work.updateProgramme(a, id, b); }
  @Get('engagements') @Perm('audit', 'view') engagements(@CurrentActor() a: RequestActor, @Query(new ZodPipe(engListQ)) q: z.infer<typeof engListQ>) { return this.work.listEngagements(a, q); }
  @Post('engagements') @Perm('audit', 'create') createEngagement(@CurrentActor() a: RequestActor, @Body(new ZodPipe(engagementIn)) b: z.infer<typeof engagementIn>) { return this.work.createEngagement(a, b); }
  @Get('engagements/:id') @Perm('audit', 'view') engagement(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.work.getEngagement(a, id); }
  @Patch('engagements/:id') @HttpCode(204) @Perm('audit', 'edit')
  async updateEngagement(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(engagementPatch)) b: z.infer<typeof engagementPatch>) { await this.work.updateEngagement(a, id, b); }
  @Post('engagements/:id/pbc') @Perm('audit', 'edit')
  addPbc(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(pbcIn)) b: z.infer<typeof pbcIn>) { return this.work.addPbc(a, id, b.items); }
  @Post('engagements/:id/pbc/remind') @Perm('audit', 'edit') remind(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.work.remindPbc(a, id); }
  @Patch('pbc/:id') @HttpCode(204) @Perm('audit', 'edit')
  async updatePbc(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(pbcPatch)) b: z.infer<typeof pbcPatch>) { await this.work.updatePbc(a, id, b); }
  @Patch('procedures/:id') @HttpCode(204) @Perm('audit', 'edit')
  async updateProcedure(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ notApplicable: z.boolean().optional(), conclusion: opt(5000) }).strict())) b: { notApplicable?: boolean; conclusion?: string | null }) {
    await this.work.updateProcedure(a, id, b);
  }
  @Post('procedures/:id/signoff') @HttpCode(204) @Perm('audit', 'edit')
  async signoff(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ level: z.enum(SIGNOFF_LEVELS) }).strict())) b: { level: (typeof SIGNOFF_LEVELS)[number] }) {
    await this.work.signoff(a, id, b.level);
  }
  @Post('procedures/:id/reopen') @HttpCode(204) @Perm('audit', 'approve')
  async reopen(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ reason: txt(500) }).strict())) b: { reason: string }) { await this.work.reopen(a, id, b.reason); }
  @Get('procedures/:id/trail') @Perm('audit', 'view') trail(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.work.trail(a, id); }
  @Get('procedures/:id/workpapers') @Perm('audit', 'view') workpapers(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.work.workpapers(a, id); }
  @Post('procedures/:id/workpapers') @Perm('audit', 'edit')
  linkWorkpaper(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ documentId: uuid }).strict())) b: { documentId: string }) { return this.work.linkWorkpaper(a, id, b.documentId); }
  @Delete('workpapers/:id') @HttpCode(204) @Perm('audit', 'edit') async unlink(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.work.unlinkWorkpaper(a, id); }
  @Get('udins') @Perm('audit', 'view')
  udins(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ clientId: uuid.optional(), engagementId: uuid.optional() }))) q: { clientId?: string; engagementId?: string }) { return this.work.listUdins(a, q); }
  @Post('udins') @Perm('audit', 'edit') recordUdin(@CurrentActor() a: RequestActor, @Body(new ZodPipe(udinIn)) b: z.infer<typeof udinIn>) { return this.work.recordUdin(a, b); }
  @Post('udins/:id/revoke') @HttpCode(204) @Perm('audit', 'approve')
  async revoke(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ reason: txt(500) }).strict())) b: { reason: string }) { await this.work.revokeUdin(a, id, b.reason); }
  /** Deep link to the official ICAI UDIN portal — UDINs are generated there, never imitated here. */
  @Get('udin-portal') @Perm('audit', 'view') portal() { return { url: udinPortalUrl(), note: 'Generate the UDIN on the official ICAI portal, then record it here.' }; }
}

// ---------- DSC register & licences ----------
/** Refuses any PIN/password-like key anywhere in the body before validation (D117). */
const noSecrets = <T extends z.ZodTypeAny>(s: T) => z.unknown().superRefine((v, ctx) => {
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (SECRET_KEY_RX.test(k)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: 'secret_not_allowed: DSC PINs/passwords are never stored' });
    // Content heuristic for free text ("PIN: 1234"); limits in KNOWN_GAPS.
    else if (typeof x === 'string' && SECRET_TEXT_RX.test(x)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: 'secret_not_allowed: looks like a PIN/password' });
  }
}).pipe(s);
const dscIn = z.object({
  clientId: uuid.nullable().optional(), holderKind: z.enum(['client_contact', 'staff']), contactId: uuid.nullable().optional(), holderUserId: uuid.nullable().optional(), holderName: opt(200),
  dscClass: z.string().trim().regex(/^[A-Za-z0-9 _-]{2,30}$/), dscType: z.enum(['sign', 'encrypt', 'combo']), issuer: txt(100), serialNo: opt(100), validFrom: isoDate, validTo: isoDate,
  tokenLabel: opt(100), custody: z.enum(['in_office', 'with_client', 'with_staff']).optional(), custodyUserId: uuid.nullable().optional(), notes: opt(2000),
}).strict();
const dscPatch = dscIn.pick({ dscClass: true, dscType: true, issuer: true, serialNo: true, validFrom: true, validTo: true, tokenLabel: true, notes: true, holderName: true }).partial().strict();
const moveIn = z.object({ to: z.enum(['in_office', 'with_client', 'with_staff']), toUserId: uuid.nullable().optional(), counterparty: opt(200), purpose: opt(300) }).strict();
const dscListQ = z.object({ clientId: uuid.optional(), custody: z.enum(['in_office', 'with_client', 'with_staff']).optional(), expiringWithinDays: z.coerce.number().int().min(-3650).max(3650).optional(), firm: bool.optional() });
const licenceType = z.string().regex(/^[a-z0-9_]{2,40}$/);
const licenceIn = z.object({ clientId: uuid, licenceType, number: opt(100), authority: opt(200), validFrom: isoDate.nullable().optional(), validTo: isoDate.nullable().optional(),
  renewalDue: isoDate.nullable().optional(), documentIds: z.array(uuid).max(20).optional(), status: z.enum(['active', 'renewal_in_progress', 'lapsed', 'surrendered']).optional(), notes: opt(2000) }).strict();
const licencePatch = licenceIn.omit({ clientId: true }).partial().strict();

@Controller()
export class DscController {
  constructor(private dsc: DscService, private practice: PracticeService) {}
  @Get('dsc') @Perm('dsc', 'view') list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(dscListQ)) q: z.infer<typeof dscListQ>) { return this.dsc.list(a, q); }
  @Post('dsc') @Perm('dsc', 'create') create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(noSecrets(dscIn))) b: z.infer<typeof dscIn>) { return this.dsc.create(a, b); }
  @Post('dsc/custody/:id/acknowledge') @HttpCode(204) @Perm('dsc', 'view')
  async ack(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(noSecrets(z.object({ name: opt(200) }).strict()))) b: { name?: string | null }) { await this.dsc.acknowledge(a, id, b); }
  @Get('dsc/:id') @Perm('dsc', 'view') get(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.dsc.get(a, id); }
  @Patch('dsc/:id') @HttpCode(204) @Perm('dsc', 'edit')
  async update(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(noSecrets(dscPatch))) b: z.infer<typeof dscPatch>) { await this.dsc.update(a, id, b); }
  @Post('dsc/:id/custody') @Perm('dsc', 'edit')
  move(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(noSecrets(moveIn))) b: z.infer<typeof moveIn>) { return this.dsc.move(a, id, b); }
  @Get('licences') @Perm('compliance', 'view')
  licences(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ clientId: uuid.optional(), status: z.string().max(30).optional(), dueWithinDays: z.coerce.number().int().min(-3650).max(3650).optional() }))) q: { clientId?: string; status?: string; dueWithinDays?: number }) {
    return this.dsc.listLicences(a, q);
  }
  @Post('licences') @Perm('compliance', 'create') createLicence(@CurrentActor() a: RequestActor, @Body(new ZodPipe(licenceIn)) b: z.infer<typeof licenceIn>) { return this.dsc.createLicence(a, b); }
  @Patch('licences/:id') @HttpCode(204) @Perm('compliance', 'edit')
  async updateLicence(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(licencePatch)) b: z.infer<typeof licencePatch>) { await this.dsc.updateLicence(a, id, b); }
  @Get('practice/settings') @Perm('settings', 'view') settings(@CurrentActor() a: RequestActor) { return this.practice.getSettings(a); }
  @Put('practice/settings') @Perm('settings', 'edit') putSettings(@CurrentActor() a: RequestActor, @Body() b: unknown) { return this.practice.putSettings(a, b); }
  @Post('practice/run') @Perm('settings', 'edit')
  run(@CurrentActor() a: RequestActor, @Body(new ZodPipe(z.object({ asOf: isoDate.optional() }).strict())) b: { asOf?: string }) { return this.practice.run(a, b.asOf); }
}

// ---------- E-signature ----------
const signerIn = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('contact'), contactId: uuid, order: z.number().int().min(1).max(20).optional() }).strict(),
  z.object({ kind: z.literal('staff'), userId: uuid, order: z.number().int().min(1).max(20).optional() }).strict(),
]);
const esignIn = z.object({ title: txt(200), mode: z.enum(['parallel', 'sequential']).default('parallel'),
  items: z.array(z.object({ documentId: uuid, version: z.number().int().min(1).optional(), signers: z.array(signerIn).min(1).max(10) }).strict()).min(1).max(200) }).strict();

@Controller('esign')
@Feature('esign') // switchable module (M22, D182)
export class EsignController {
  constructor(private esign: EsignService) {}
  @Get('requests') @Perm('documents', 'view')
  list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ status: z.string().max(30).optional(), ...page }))) q: { status?: string; limit: number; offset: number }) { return this.esign.list(a, q); }
  @Post('requests') @Perm('documents', 'edit') create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(esignIn)) b: z.infer<typeof esignIn>) { return this.esign.create(a, b); }
  @Get('requests/:id') @Perm('documents', 'view') get(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.esign.get(a, id); }
  @Post('requests/:id/retry') @Perm('documents', 'edit') retry(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.esign.retry(a, id); }
  @Post('requests/:id/cancel') @HttpCode(204) @Perm('documents', 'edit') async cancel(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.esign.cancel(a, id); }
  /** Public signer link (signed token): resolves to the provider's signing page. */
  @Get('sign/:token') @Public() open(@Param('token', new ZodPipe(z.string().min(20).max(1000))) token: string) { return this.esign.openLink(token); }
  /** Provider callback: signature over the raw body, idempotent per event id; mock only outside production. */
  @Post('webhooks/:provider/:tenantId') @HttpCode(200) @Public()
  webhook(@Param('provider', new ZodPipe(z.enum(['mock', 'asp']))) provider: string, @Param('tenantId') tenantId: string, @Req() req: Request & { rawBody?: Buffer }) {
    return this.esign.webhook(provider, tenantId, req.rawBody, req.headers);
  }
}
