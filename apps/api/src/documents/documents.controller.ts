import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { CurrentActor, Perm, Public, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { DocumentsService, MAX_UPLOAD } from './documents.service.js';
import { PublicApi } from '../publicapi/decorators.js';

const fy = z.string().regex(/^\d{4}-\d{2}$/);
const uploadB = z.object({
  clientId: z.string().uuid().optional(), fy: fy.optional(), category: z.string().trim().min(1).max(100).optional(), name: z.string().trim().min(1).max(300).optional(),
  tags: z.preprocess((v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v), z.array(z.string().max(50)).max(30)).optional(),
  permanent: z.preprocess((v) => v === 'true' || v === true, z.boolean()).optional(), expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  documentId: z.string().uuid().optional(), note: z.string().max(500).optional(),
});
const listQ = z.object({
  clientId: z.string().uuid().optional(), fy: fy.optional(), category: z.string().max(100).optional(), q: z.string().max(200).optional(),
  trashed: z.enum(['true', 'false']).transform((v) => v === 'true').optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0),
});
const metaB = z.object({ name: z.string().trim().min(1).max(300).optional(), category: z.string().trim().min(1).max(100).optional(), fy: fy.nullable().optional(),
  tags: z.array(z.string().max(50)).max(30).optional(), permanent: z.boolean().optional(), expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), legalHold: z.boolean().optional(), clientVisible: z.boolean().optional() });
const shareB = z.object({ expiresInHours: z.number().int().min(1).max(720), password: z.string().min(6).max(100).optional(), maxDownloads: z.number().int().min(1).max(1000).optional() });

/** Streams a stored file as an attachment with headers that stop it rendering as active content in our origin. */
function send(res: Response, f: { name: string; mime: string; size: number; stream: Readable }) {
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Length', String(f.size));
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, no-store');
  f.stream.pipe(res);
}

@Controller()
export class DocumentsController {
  constructor(private docs: DocumentsService) {}

  @Post('documents') @Perm('documents', 'create') @PublicApi()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD, files: 1 } }))
  upload(@CurrentActor() a: RequestActor, @UploadedFile() file: Express.Multer.File, @Body(new ZodPipe(uploadB)) b: z.infer<typeof uploadB>, @Req() req: Request) {
    return this.docs.upload(a, file, b, req.ip ?? null);
  }

  @Get('documents') @Perm('documents', 'view') @PublicApi()
  list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listQ)) q: z.infer<typeof listQ>) { return this.docs.list(a, q); }

  @Get('clients/:id/document-tree') @Perm('documents', 'view')
  tree(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.docs.tree(a, id); }

  @Get('documents/:id/versions') @Perm('documents', 'view')
  versions(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.docs.versions(a, id); }

  @Patch('documents/:id') @HttpCode(204) @Perm('documents', 'edit')
  async update(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(metaB)) b: z.infer<typeof metaB>) { await this.docs.updateMeta(a, id, b); }

  @Delete('documents/:id') @HttpCode(204) @Perm('documents', 'delete')
  async trash(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.docs.trash(a, id, false); }

  @Post('documents/:id/restore') @HttpCode(204) @Perm('documents', 'delete')
  async restore(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.docs.trash(a, id, true); }

  @Post('documents/:id/download-url') @HttpCode(200) @Perm('documents', 'view')
  downloadUrl(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ version: z.number().int().min(1).optional() }))) b: { version?: number }) {
    return this.docs.downloadUrl(a, id, b.version);
  }

  @Public() @Get('files/:token')
  async file(@Param('token') token: string, @Req() req: Request, @Res() res: Response) { send(res, await this.docs.openSigned(token, req.ip ?? null)); }

  @Get('documents/:id/access-log') @Perm('documents', 'view')
  accessLog(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.docs.accessLog(a, id); }

  @Get('documents/:id/shares') @Perm('documents', 'view')
  shares(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.docs.shares(a, id); }

  @Post('documents/:id/shares') @Perm('documents', 'export')
  share(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(shareB)) b: z.infer<typeof shareB>) { return this.docs.createShare(a, id, b); }

  @Delete('shares/:id') @HttpCode(204) @Perm('documents', 'export')
  async revokeShare(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.docs.revokeShare(a, id); }

  /** Public share link; POST carries a password so it never lands in URLs or logs. */
  @Public() @Throttle({ default: { limit: 30, ttl: 60_000 } }) @Get('share/:token')
  async shareGet(@Param('token') token: string, @Req() req: Request, @Res() res: Response) { send(res, await this.docs.openShare(token, undefined, req.ip ?? null)); }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('share/:token') @HttpCode(200)
  async sharePost(@Param('token') token: string, @Body(new ZodPipe(z.object({ password: z.string().max(100) }))) b: { password: string }, @Req() req: Request, @Res() res: Response) {
    send(res, await this.docs.openShare(token, b.password, req.ip ?? null));
  }
}
