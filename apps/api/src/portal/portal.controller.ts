import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { COMM_CHANNELS, PROFILE_FIELDS } from '@worko/domain';
import type { Request, Response } from 'express';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { CurrentActor, CurrentPortal, Perm, PortalAllowed, Public, type PortalActor, type RequestActor, Feature } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { MAX_UPLOAD } from '../documents/documents.service.js';
import { PortalAdminService } from './admin.service.js';
import { PortalAuthService } from './portal-auth.service.js';
import { PortalService } from './portal.service.js';

const firm = z.string().trim().min(2).max(63);
const identifier = z.string().trim().min(5).max(200);
const device = z.object({ platform: z.enum(['web', 'android']), label: z.string().max(100).optional() }).strict();
const AUTH_LIMIT = { default: { limit: Number(process.env.PORTAL_AUTH_RATE_LIMIT ?? process.env.AUTH_RATE_LIMIT ?? 10), ttl: 60_000 } };
const uuid = new ParseUUIDPipe();
const fy = z.string().regex(/^\d{4}-\d{2}$/);
const uploadB = z.object({ name: z.string().trim().min(1).max(300).optional(), fy: fy.optional(), note: z.string().max(500).optional() }).strict();
const respondB = z.object({ message: z.string().trim().max(5000).optional() }).strict();
const msgB = z.object({ body: z.string().trim().min(1).max(5000) }).strict();
const profileB = z.object({ clientId: z.string().uuid(), changes: z.object(Object.fromEntries(PROFILE_FIELDS.map((f) => [f, z.string().trim().max(200).nullable().optional()]))).strict() }).strict();
const consentB = z.object({ clientId: z.string().uuid(), channel: z.enum(COMM_CHANNELS), status: z.enum(['opted_in', 'opted_out']) }).strict();

function stream(res: Response, f: { name?: string; mime: string; size: number; stream: Readable }, inline = false) {
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Length', String(f.size));
  if (!inline) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name ?? 'file')}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', inline ? 'public, max-age=300' : 'private, no-store');
  f.stream.pipe(res);
}

/** Public portal endpoints: OTP sign-in (enumeration-safe, rate-limited), refresh, branding, signed file downloads. */
@Controller('portal')
export class PortalPublicController {
  constructor(private auth: PortalAuthService, private admin: PortalAdminService, private portal: PortalService) {}

  @Public() @Throttle(AUTH_LIMIT) @Post('auth/otp/request') @HttpCode(202)
  otpRequest(@Body(new ZodPipe(z.object({ firm, identifier }).strict())) b: { firm: string; identifier: string }) {
    this.auth.requestOtp(b.firm, b.identifier); // deferred: nothing about the person is looked up on the request path
    return { sent: true }; // identical whether or not the person/firm exists
  }

  @Public() @Throttle(AUTH_LIMIT) @Post('auth/otp/verify') @HttpCode(200)
  otpVerify(@Body(new ZodPipe(z.object({ firm, identifier, code: z.string().regex(/^\d{6}$/), device }).strict())) b: { firm: string; identifier: string; code: string; device: z.infer<typeof device> }, @Req() req: Request) {
    return this.auth.verifyOtp(b.firm, b.identifier, b.code, b.device, { ip: req.ip ?? null, userAgent: req.headers['user-agent'] });
  }

  @Public() @Throttle({ default: { limit: 30, ttl: 60_000 } }) @Post('auth/refresh') @HttpCode(200)
  refresh(@Body(new ZodPipe(z.object({ refreshToken: z.string().min(20).max(300) }).strict())) b: { refreshToken: string }) { return this.auth.refresh(b.refreshToken); }

  @Public() @Throttle({ default: { limit: 60, ttl: 60_000 } }) @Get('branding/:firm')
  branding(@Param('firm', new ZodPipe(firm)) f: string) { return this.admin.branding(f); }

  @Public() @Throttle({ default: { limit: 60, ttl: 60_000 } }) @Get('branding/:firm/logo')
  async logo(@Param('firm', new ZodPipe(firm)) f: string, @Res() res: Response) { stream(res, await this.admin.logo(f), true); }

  @Public() @Get('files/:token')
  async file(@Param('token', new ZodPipe(z.string().min(20).max(2000))) token: string, @Req() req: Request, @Res() res: Response) { stream(res, await this.portal.openFile(token, req.ip ?? null)); }
}

/** Client-facing portal API. Every route is portal-session only; tenant and client scope come from the session + grants, never from input alone. */
@Controller('portal')
@PortalAllowed()
@Feature('portal') // switchable module (M22, D182)
export class PortalController {
  constructor(private auth: PortalAuthService, private portal: PortalService) {}

  @Post('auth/logout') @HttpCode(204) async logout(@CurrentPortal() p: PortalActor) { await this.auth.logout(p); }
  @Get('me') me(@CurrentPortal() p: PortalActor) { return this.portal.me(p); }
  @Get('profile') profile(@CurrentPortal() p: PortalActor) { return this.portal.profile(p); }
  @Post('profile/requests') profileRequest(@CurrentPortal() p: PortalActor, @Body(new ZodPipe(profileB)) b: z.infer<typeof profileB>) { return this.portal.profileRequest(p, b); }
  @Put('consent') consent(@CurrentPortal() p: PortalActor, @Body(new ZodPipe(consentB)) b: z.infer<typeof consentB>) { return this.portal.setConsent(p, b); }

  @Get('clients/:clientId/dashboard') dashboard(@CurrentPortal() p: PortalActor, @Param('clientId', uuid) c: string) { return this.portal.dashboard(p, c); }
  @Get('clients/:clientId/documents')
  documents(@CurrentPortal() p: PortalActor, @Param('clientId', uuid) c: string, @Query(new ZodPipe(z.object({ fy: fy.optional(), category: z.string().max(100).optional() }))) q: { fy?: string; category?: string }) {
    return this.portal.documents(p, c, q);
  }
  @Post('clients/:clientId/documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD, files: 1 } }))
  upload(@CurrentPortal() p: PortalActor, @Param('clientId', uuid) c: string, @UploadedFile() file: Express.Multer.File, @Body(new ZodPipe(uploadB)) b: z.infer<typeof uploadB>, @Req() req: Request) {
    return this.portal.upload(p, c, file, b, req.ip ?? null);
  }
  @Post('clients/:clientId/documents/:id/download-url') @HttpCode(200)
  download(@CurrentPortal() p: PortalActor, @Param('clientId', uuid) c: string, @Param('id', uuid) id: string) { return this.portal.downloadUrl(p, c, id); }

  @Get('clients/:clientId/requests') requests(@CurrentPortal() p: PortalActor, @Param('clientId', uuid) c: string) { return this.portal.requests(p, c); }
  @Post('clients/:clientId/requests/:kind/:id/respond') @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD, files: 1 } }))
  respond(@CurrentPortal() p: PortalActor, @Param('clientId', uuid) c: string, @Param('kind', new ZodPipe(z.enum(['pbc', 'task']))) kind: 'pbc' | 'task', @Param('id', uuid) id: string,
    @UploadedFile() file: Express.Multer.File | undefined, @Body(new ZodPipe(respondB)) b: z.infer<typeof respondB>, @Req() req: Request) {
    return this.portal.respond(p, c, kind, id, b, file, req.ip ?? null);
  }

  @Get('clients/:clientId/invoices') invoices(@CurrentPortal() p: PortalActor, @Param('clientId', uuid) c: string) { return this.portal.invoiceList(p, c); }
  @Get('clients/:clientId/invoices/:id') invoice(@CurrentPortal() p: PortalActor, @Param('clientId', uuid) c: string, @Param('id', uuid) id: string) { return this.portal.invoice(p, c, id); }
  @Get('clients/:clientId/invoices/:id/pdf')
  async pdf(@CurrentPortal() p: PortalActor, @Param('clientId', uuid) c: string, @Param('id', uuid) id: string, @Res() res: Response) {
    const f = await this.portal.invoicePdf(p, c, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(f.pdf);
  }
  @Post('clients/:clientId/invoices/:id/pay') @HttpCode(200) pay(@CurrentPortal() p: PortalActor, @Param('clientId', uuid) c: string, @Param('id', uuid) id: string) { return this.portal.pay(p, c, id); }
  @Get('clients/:clientId/receipts') receipts(@CurrentPortal() p: PortalActor, @Param('clientId', uuid) c: string) { return this.portal.receipts(p, c); }

  @Get('clients/:clientId/messages') messages(@CurrentPortal() p: PortalActor, @Param('clientId', uuid) c: string) { return this.portal.messages(p, c); }
  @Post('clients/:clientId/messages') post(@CurrentPortal() p: PortalActor, @Param('clientId', uuid) c: string, @Body(new ZodPipe(msgB)) b: { body: string }) { return this.portal.postMessage(p, c, b.body); }

  @Get('clients/:clientId/esign') esign(@CurrentPortal() p: PortalActor, @Param('clientId', uuid) c: string) { return this.portal.esign(p, c); }
  @Get('clients/:clientId/notices') notices(@CurrentPortal() p: PortalActor, @Param('clientId', uuid) c: string) { return this.portal.notices(p, c); }
}

const accessB = z.object({ grants: z.unknown().optional(), revoked: z.boolean().optional() }).strict();
const inviteB = z.object({ clientId: z.string().uuid(), contactId: z.string().uuid(), grants: z.unknown().optional(), channel: z.enum(COMM_CHANNELS).optional(), send: z.boolean().optional(), linkExisting: z.boolean().optional() }).strict();

/** Staff administration of the portal (staff sessions only). */
@Controller('portal-admin')
@Feature('portal') // switchable module (M22, D182)
export class PortalAdminController {
  constructor(private admin: PortalAdminService) {}

  @Get('settings') @Perm('settings', 'view') settings(@CurrentActor() a: RequestActor) { return this.admin.settings(a); }
  @Put('settings') @Perm('settings', 'edit') put(@CurrentActor() a: RequestActor, @Body() b: unknown) { return this.admin.putSettings(a, b); }
  @Put('clients/:id/enabled') @HttpCode(204) @Perm('clients', 'edit')
  async enable(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string, @Body(new ZodPipe(z.object({ enabled: z.boolean() }).strict())) b: { enabled: boolean }) { await this.admin.setClientPortal(a, id, b.enabled); }
  @Get('clients/:id/messages') @Perm('communication', 'view') thread(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string) { return this.admin.thread(a, id); }
  @Post('clients/:id/messages') @Perm('communication', 'create') reply(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string, @Body(new ZodPipe(msgB)) b: { body: string }) { return this.admin.reply(a, id, b.body); }
  @Get('users') @Perm('clients', 'view') users(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ clientId: z.string().uuid().optional() }))) q: { clientId?: string }) { return this.admin.users(a, q); }
  @Patch('users/:id') @HttpCode(204) @Perm('clients', 'edit')
  async user(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string, @Body(new ZodPipe(z.object({ status: z.enum(['active', 'disabled']) }).strict())) b: { status: 'active' | 'disabled' }) { await this.admin.updateUser(a, id, b); }
  @Post('invites') @Perm('clients', 'edit') invite(@CurrentActor() a: RequestActor, @Body(new ZodPipe(inviteB)) b: z.infer<typeof inviteB>) { return this.admin.invite(a, b); }
  @Patch('access/:id') @HttpCode(204) @Perm('clients', 'edit')
  async access(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string, @Body(new ZodPipe(accessB)) b: z.infer<typeof accessB>) { await this.admin.updateAccess(a, id, b); }
  @Get('profile-requests') @Perm('clients', 'view')
  requests(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() }))) q: { status?: string }) { return this.admin.profileRequests(a, q); }
  @Post('profile-requests/:id/decide') @HttpCode(204) @Perm('clients', 'edit')
  async decide(@CurrentActor() a: RequestActor, @Param('id', uuid) id: string, @Body(new ZodPipe(z.object({ approve: z.boolean(), reason: z.string().max(500).nullable().optional() }).strict())) b: { approve: boolean; reason?: string | null }) {
    await this.admin.decideProfileRequest(a, id, b);
  }
}
