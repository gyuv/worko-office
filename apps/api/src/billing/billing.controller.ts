import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { gstinSchema, INVOICE_KINDS, INVOICE_PREFIX_REGEX, INVOICE_STATUSES, panSchema, RECEIPT_MODES, TALLY_ACCOUNTS } from '@worko/domain';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentActor, Perm, Public, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { Clock } from '../common/clock.js';
import { requireFirmWide } from '../tasks/system-actor.js';
import { BillingAutoService } from './auto.service.js';
import { CollectionsService } from './collections.service.js';
import { BillingConfigService } from './config.service.js';
import { InvoicesService } from './invoices.service.js';
import { verifyInvoiceLink } from './providers.js';
import { ReceiptsService } from './receipts.service.js';
import { BillingReportsService } from './reports.service.js';
import { PublicApi } from '../publicapi/decorators.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const paise = z.number().int().min(0).max(1e13);
const uuidN = z.string().uuid().nullable().optional();
const fmt = z.object({ format: z.enum(['csv', 'xlsx']).default('csv'), from: date.optional(), to: date.optional() });

const entityB = z.object({
  name: z.string().trim().min(1).max(200), frn: z.string().trim().max(20).nullable().optional(), pan: panSchema.nullable().optional(), gstin: gstinSchema.nullable().optional(),
  stateCode: z.string().regex(/^\d{2}$/), address: z.string().max(500).nullable().optional(), email: z.string().email().nullable().optional(), phone: z.string().max(20).nullable().optional(),
  bank: z.object({ name: z.string().max(100), accountNo: z.string().regex(/^\d{6,20}$/), ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/), branch: z.string().max(100), upiId: z.string().max(100) }).partial().optional(),
  invoicePrefix: z.string().regex(INVOICE_PREFIX_REGEX).optional(), logoDocId: uuidN, active: z.boolean().optional(),
}).strict();
const ladderB = z.array(z.object({ step: z.number().int().min(0).max(20), daysAfterDue: z.number().int().min(-30).max(365), channels: z.array(z.enum(['email', 'whatsapp'])).max(2), escalate: z.boolean().optional() }).strict())
  .max(10).refine((l) => new Set(l.map((s) => s.step)).size === l.length, 'Duplicate step');
const settingsB = z.object({
  defaultEntityId: uuidN, dueDays: z.number().int().min(0).max(365).optional(), defaultGstRate: z.number().min(0).max(28).optional(),
  defaultSac: z.string().regex(/^\d{4,8}$/).optional(), ladder: ladderB.optional(), terms: z.string().max(2000).nullable().optional(),
}).strict();
const rateB = z.object({ serviceTypeId: z.string().uuid(), clientId: uuidN, groupId: uuidN, amountPaise: paise, effectiveFrom: date, effectiveTo: date.nullable().optional(), notes: z.string().max(500).nullable().optional() })
  .strict().refine((r) => !(r.clientId && r.groupId), 'Client or group, not both');
const ratePatchB = z.object({ amountPaise: paise.optional(), effectiveTo: date.nullable().optional(), notes: z.string().max(500).nullable().optional(), deleted: z.boolean().optional() }).strict();
const lineB = z.object({
  description: z.string().trim().min(1).max(500), sac: z.string().regex(/^\d{4,8}$/).nullable().optional(), serviceTypeId: uuidN,
  qty: z.number().positive().max(100_000).multipleOf(0.01).default(1), ratePaise: paise, discountPaise: paise.optional(), gstRate: z.number().min(0).max(28).nullable().optional(),
  reimbursement: z.boolean().optional(), taskIds: z.array(z.string().uuid()).max(100).optional(),
}).strict();
const draftB = z.object({ clientId: z.string().uuid(), entityId: uuidN, notes: z.string().max(2000).nullable().optional(), lines: z.array(lineB).min(1).max(200) }).strict();
const draftPatchB = z.object({ entityId: uuidN, notes: z.string().max(2000).nullable().optional(), lines: z.array(lineB).min(1).max(200).optional() }).strict();
const issueB = z.object({ issueDate: date, dueDate: date.nullable().optional() }).strict();
const cancelB = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const noteB = z.object({
  kind: z.enum(['credit_note', 'debit_note']), date, reason: z.string().trim().min(3).max(500),
  lines: z.array(z.object({ description: z.string().trim().min(1).max(500), taxablePaise: paise.refine((x) => x > 0), gstRate: z.number().min(0).max(28).nullable().optional(), sac: z.string().regex(/^\d{4,8}$/).nullable().optional(), reimbursement: z.boolean().optional() }).strict()).min(1).max(50),
}).strict();
const followB = z.object({ promiseToPay: date.nullable().optional(), paused: z.boolean().optional() }).strict();
const sendB = z.object({ channel: z.enum(['email', 'whatsapp']) }).strict();
const listQ = z.object({
  status: z.string().max(200).transform((s) => s.split(',').filter(Boolean)).pipe(z.array(z.enum(INVOICE_STATUSES))).optional(), kind: z.enum(INVOICE_KINDS).optional(),
  clientId: z.string().uuid().optional(), from: date.optional(), to: date.optional(), overdueAsOf: date.optional(), q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200), offset: z.coerce.number().int().min(0).default(0),
});
const allocB = z.array(z.object({ invoiceId: z.string().uuid(), amountPaise: paise, tdsPaise: paise.optional() }).strict()).max(200);
const receiptB = z.object({
  clientId: z.string().uuid(), entityId: uuidN, receivedOn: date, amountPaise: paise, tdsPaise: paise.optional(), tdsSection: z.string().trim().max(20).nullable().optional(),
  mode: z.enum(RECEIPT_MODES), reference: z.string().max(100).nullable().optional(), notes: z.string().max(1000).nullable().optional(), allocations: allocB.optional(),
}).strict();
const receiptsQ = z.object({ clientId: z.string().uuid().optional(), from: date.optional(), to: date.optional(), limit: z.coerce.number().int().min(1).max(1000).default(200), offset: z.coerce.number().int().min(0).default(0) });
const autoB = z.object({ from: date.optional(), to: date, clientIds: z.array(z.string().uuid()).max(5000).optional(), entityId: uuidN }).strict();
const monthB = z.object({ month }).strict();
const tallyB = z.object({ entityId: z.string().uuid(), from: date, to: date, force: z.boolean().optional() }).strict();
const ledgersB = z.array(z.object({
  entityId: uuidN, ledgerName: z.string().trim().min(1).max(200).nullable(),
  accountKey: z.string().regex(/^[a-z_]+(:[A-Za-z0-9_-]+)?$/).refine((k) => (TALLY_ACCOUNTS as readonly string[]).includes(k) || /^(sales|party):/.test(k), 'Unknown account'),
}).strict()).min(1).max(500);
const followRunB = z.object({ asOf: date }).strict();

const sendFile = (res: Response, f: { name: string; mime: string; body: Buffer }) => {
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(f.body);
};
const sendPdf = (res: Response, f: { name: string; pdf: Buffer }) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${f.name}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(f.pdf);
};

@Controller('billing')
export class BillingController {
  constructor(
    private config: BillingConfigService, private invoices: InvoicesService, private receipts: ReceiptsService, private auto: BillingAutoService,
    private reports: BillingReportsService, private collections: CollectionsService, private clock: Clock,
  ) {}

  // ---------- Firm configuration ----------
  @Get('entities') @Perm('billing', 'view')
  entities(@CurrentActor() a: RequestActor) { return this.config.entities(a); }

  @Post('entities') @Perm('settings', 'edit')
  createEntity(@CurrentActor() a: RequestActor, @Body(new ZodPipe(entityB)) b: z.infer<typeof entityB>) { return this.config.createEntity(a, b); }

  @Patch('entities/:id') @HttpCode(204) @Perm('settings', 'edit')
  async updateEntity(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(entityB.partial())) b: z.infer<typeof entityB>) { await this.config.updateEntity(a, id, b); }

  @Get('settings') @Perm('billing', 'view')
  settings(@CurrentActor() a: RequestActor) { return this.config.settings(a); }

  @Put('settings') @HttpCode(204) @Perm('settings', 'edit')
  async putSettings(@CurrentActor() a: RequestActor, @Body(new ZodPipe(settingsB)) b: z.infer<typeof settingsB>) { await this.config.putSettings(a, b); }

  @Get('rates') @Perm('billing', 'view')
  rates(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ serviceTypeId: z.string().uuid().optional(), clientId: z.string().uuid().optional() }))) q: { serviceTypeId?: string; clientId?: string }) {
    return this.config.rates(a, q);
  }

  @Post('rates') @Perm('settings', 'edit')
  createRate(@CurrentActor() a: RequestActor, @Body(new ZodPipe(rateB)) b: z.infer<typeof rateB>) { return this.config.createRate(a, b); }

  @Patch('rates/:id') @HttpCode(204) @Perm('settings', 'edit')
  async updateRate(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ratePatchB)) b: z.infer<typeof ratePatchB>) { await this.config.updateRate(a, id, b); }

  @Get('tally/ledgers') @Perm('billing', 'view')
  ledgers(@CurrentActor() a: RequestActor) { return this.config.ledgers(a); }

  @Put('tally/ledgers') @HttpCode(204) @Perm('settings', 'edit')
  async putLedgers(@CurrentActor() a: RequestActor, @Body(new ZodPipe(ledgersB)) b: z.infer<typeof ledgersB>) { await this.config.putLedgers(a, b); }

  // ---------- Invoices ----------
  @Get('invoices') @Perm('billing', 'view') @PublicApi()
  list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listQ)) q: z.infer<typeof listQ>) { return this.invoices.list(a, q); }

  @Get('invoices/export') @Perm('billing', 'export')
  async exportInvoices(@CurrentActor() a: RequestActor, @Query(new ZodPipe(fmt)) q: z.infer<typeof fmt>, @Res() res: Response) { sendFile(res, await this.reports.exportInvoices(a, q)); }

  @Post('invoices') @Perm('billing', 'create')
  create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(draftB)) b: z.infer<typeof draftB>) { return this.invoices.create(a, b); }

  @Get('invoices/:id') @Perm('billing', 'view') @PublicApi()
  get(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.invoices.get(a, id); }

  @Patch('invoices/:id') @HttpCode(204) @Perm('billing', 'edit')
  async update(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(draftPatchB)) b: z.infer<typeof draftPatchB>) { await this.invoices.update(a, id, b); }

  @Delete('invoices/:id') @HttpCode(204) @Perm('billing', 'edit')
  async remove(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.invoices.remove(a, id); }

  @Post('invoices/:id/issue') @HttpCode(200) @Perm('billing', 'edit')
  issue(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(issueB)) b: z.infer<typeof issueB>) { return this.invoices.issue(a, id, b); }

  @Post('invoices/:id/cancel') @HttpCode(204) @Perm('billing', 'approve')
  async cancel(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(cancelB)) b: z.infer<typeof cancelB>) { await this.invoices.cancel(a, id, b.reason); }

  @Post('invoices/:id/notes') @Perm('billing', 'approve')
  note(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(noteB)) b: z.infer<typeof noteB>) { return this.invoices.note(a, id, b); }

  @Post('invoices/:id/follow-up') @HttpCode(204) @Perm('billing', 'edit')
  async followUp(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(followB)) b: z.infer<typeof followB>) { await this.invoices.setFollowup(a, id, b); }

  @Post('invoices/:id/send') @HttpCode(200) @Perm('billing', 'edit')
  send(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(sendB)) b: z.infer<typeof sendB>) { return this.collections.send(a, id, b.channel); }

  @Post('invoices/:id/payment-link') @Perm('billing', 'edit')
  paymentLink(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.collections.paymentLink(a, id); }

  @Get('invoices/:id/pdf') @Perm('billing', 'print')
  async pdf(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) { sendPdf(res, await this.invoices.pdf(a, a.tenantId, id)); }

  // ---------- Auto-billing & retainers ----------
  @Post('auto/preview') @HttpCode(200) @Perm('billing', 'create')
  autoPreview(@CurrentActor() a: RequestActor, @Body(new ZodPipe(autoB)) b: z.infer<typeof autoB>) { return this.auto.preview(a, b); }

  @Post('auto/commit') @HttpCode(200) @Perm('billing', 'create')
  autoCommit(@CurrentActor() a: RequestActor, @Body(new ZodPipe(autoB)) b: z.infer<typeof autoB>) { return this.auto.commit(a, b); }

  @Post('retainers/preview') @HttpCode(200) @Perm('billing', 'create')
  retainerPreview(@CurrentActor() a: RequestActor, @Body(new ZodPipe(monthB)) b: z.infer<typeof monthB>) { return this.auto.previewRetainers(a, b.month); }

  @Post('retainers/commit') @HttpCode(200) @Perm('billing', 'create')
  retainerCommit(@CurrentActor() a: RequestActor, @Body(new ZodPipe(monthB)) b: z.infer<typeof monthB>) { return this.auto.commitRetainers(a, b.month); }

  // ---------- Receipts ----------
  @Get('receipts') @Perm('receipts', 'view')
  receiptsList(@CurrentActor() a: RequestActor, @Query(new ZodPipe(receiptsQ)) q: z.infer<typeof receiptsQ>) { return this.receipts.list(a, q); }

  @Get('receipts/export') @Perm('receipts', 'export')
  async exportReceipts(@CurrentActor() a: RequestActor, @Query(new ZodPipe(fmt)) q: z.infer<typeof fmt>, @Res() res: Response) { sendFile(res, await this.reports.exportReceipts(a, q)); }

  @Post('receipts') @Perm('receipts', 'create') @PublicApi()
  createReceipt(@CurrentActor() a: RequestActor, @Body(new ZodPipe(receiptB)) b: z.infer<typeof receiptB>) { return this.receipts.create(a, b); }

  @Get('receipts/:id') @Perm('receipts', 'view')
  receipt(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.receipts.get(a, id); }

  @Post('receipts/:id/apply') @HttpCode(200) @Perm('receipts', 'edit')
  apply(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ allocations: allocB.optional() }).strict())) b: { allocations?: z.infer<typeof allocB> }) {
    return this.receipts.apply(a, id, b.allocations);
  }

  @Get('receipts/:id/pdf') @Perm('receipts', 'print')
  async receiptPdf(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) { sendPdf(res, await this.receipts.pdf(a, id)); }

  // ---------- Reports ----------
  @Get('ageing') @Perm('billing', 'view')
  ageing(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ asOf: date.optional() }))) q: { asOf?: string }) { return this.reports.ageing(a, q.asOf ?? this.clock.todayIst()); }

  @Get('unbilled') @Perm('billing', 'view')
  unbilled(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ from: date.optional(), to: date.optional(), clientId: z.string().uuid().optional() }))) q: { from?: string; to?: string; clientId?: string }) {
    return this.auto.unbilled(a, q);
  }

  @Get('clients/:id/outstanding') @Perm('billing', 'view')
  outstanding(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.reports.outstanding(a, id); }

  // ---------- Follow-ups, Tally ----------
  @Post('follow-ups/run') @HttpCode(200) @Perm('settings', 'edit')
  runFollowups(@CurrentActor() a: RequestActor, @Body(new ZodPipe(followRunB)) b: z.infer<typeof followRunB>) {
    requireFirmWide(a, 'settings', 'edit');
    if (b.asOf > this.clock.todayIst()) throw new BadRequestException({ message: 'asOf cannot be in the future', code: 'date_in_future' });
    return this.collections.runFollowups(a.tenantId, b.asOf);
  }

  @Post('tally/dry-run') @HttpCode(200) @Perm('billing', 'export')
  async tallyDryRun(@CurrentActor() a: RequestActor, @Body(new ZodPipe(tallyB)) b: z.infer<typeof tallyB>) {
    const r = await this.reports.tallyDryRun(a, b);
    return { xml: r.xml, errors: r.errors, count: r.count, invoices: r.invoices, receipts: r.receipts };
  }

  @Post('tally/export') @HttpCode(200) @Perm('billing', 'export')
  tallyExport(@CurrentActor() a: RequestActor, @Body(new ZodPipe(tallyB)) b: z.infer<typeof tallyB>) { return this.reports.tallyExport(a, b); }

  // ---------- Public ----------
  /** Payment provider webhook: signature over the raw body, idempotent per provider event id. */
  @Post('webhooks/:provider/:tenantId') @HttpCode(200) @Public()
  webhook(@Param('provider', new ZodPipe(z.enum(['mock', 'razorpay']))) provider: string, @Param('tenantId') tenantId: string, @Req() req: Request & { rawBody?: Buffer }) {
    return this.collections.webhook(provider, tenantId, req.rawBody, req.headers);
  }

  /** Signed invoice link sent to clients (PDF of an issued invoice; 30-day expiry). */
  @Get('public/:token') @Public()
  async publicInvoice(@Param('token') token: string, @Res() res: Response) {
    const v = verifyInvoiceLink(token);
    if (!v) { res.status(404).json({ statusCode: 404, message: 'Link expired or invalid' }); return; }
    const f = await this.invoices.pdf(null, v.tenantId, v.invoiceId);
    res.setHeader('Content-Security-Policy', 'sandbox');
    sendPdf(res, f);
  }
}
