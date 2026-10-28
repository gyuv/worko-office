import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentActor, Perm, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { SYNC_TABLES } from '../sync/registry.js';
import { RegistersService, type Kind } from './registers.service.js';

const kindP = new ZodPipe(z.enum(['inward', 'outward']));
const listQ = z.object({
  q: z.string().max(100).optional(), clientId: z.string().uuid().optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  pending: z.enum(['true', 'false']).transform((v) => v === 'true').optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0),
});
// Same validation as device sync: the registry's writable schemas.
// Strict: server-assigned columns (number, fy, received_by…) are refused, not silently dropped.
const writable = (k: Kind) => z.object(SYNC_TABLES[k === 'inward' ? 'inward_entry' : 'outward_entry']!.writable).partial().strict();
const createSchema = (k: Kind) => writable(k)
  .required(k === 'inward' ? { client_id: true, received_on: true, mode: true, description: true } : { client_id: true, sent_on: true, mode: true, description: true });

@Controller('registers')
export class RegistersController {
  constructor(private reg: RegistersService) {}

  @Get(':kind') @Perm('registers', 'view')
  list(@CurrentActor() a: RequestActor, @Param('kind', kindP) kind: Kind, @Query(new ZodPipe(listQ)) q: z.infer<typeof listQ>) { return this.reg.list(a, kind, q); }

  @Post(':kind') @Perm('registers', 'create')
  create(@CurrentActor() a: RequestActor, @Param('kind', kindP) kind: Kind, @Body() body: unknown) {
    return this.reg.create(a, kind, new ZodPipe(createSchema(kind)).transform(body) as Record<string, unknown>);
  }

  @Patch(':kind/:id') @HttpCode(204) @Perm('registers', 'edit')
  async update(@CurrentActor() a: RequestActor, @Param('kind', kindP) kind: Kind, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    await this.reg.update(a, kind, id, new ZodPipe(writable(kind).omit({ client_id: true })).transform(body) as Record<string, unknown>);
  }

  @Post(':kind/:id/signature') @Perm('registers', 'edit') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1 } }))
  signature(@CurrentActor() a: RequestActor, @Param('kind', kindP) kind: Kind, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File) {
    return this.reg.attachSignature(a, kind, id, file);
  }

  @Get(':kind/:id/receipt.pdf') @Perm('registers', 'print')
  async receipt(@CurrentActor() a: RequestActor, @Param('kind', kindP) kind: Kind, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const r = await this.reg.receipt(a, kind, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${r.name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(r.pdf);
  }
}
