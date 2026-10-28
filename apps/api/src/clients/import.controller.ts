import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentActor, Perm, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { clientCreate } from './clients.schemas.js';
import { ImportService } from './import.service.js';

@Controller('clients')
export class ImportController {
  constructor(private imp: ImportService) {}

  /** Step 1 of the import wizard: parse, map columns, validate, flag duplicates. Nothing is written. */
  @Post('import/preview') @HttpCode(200) @Perm('clients', 'create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  async preview(@CurrentActor() a: RequestActor, @UploadedFile() file: Express.Multer.File, @Body('mapping') mapping?: string) {
    if (!file) throw new BadRequestException('Attach a .xlsx or .csv file');
    let override: Record<string, string> = {};
    if (mapping) {
      const m = z.record(z.string().max(50)).safeParse(JSON.parse(mapping));
      if (!m.success) throw new BadRequestException('Bad mapping');
      override = m.data;
    }
    return this.imp.preview(a, await this.imp.readTable(file), override);
  }

  /** Step 2: create the rows the user confirmed (re-validated here). */
  @Post('import/commit') @HttpCode(200) @Perm('clients', 'create')
  commit(@CurrentActor() a: RequestActor, @Body(new ZodPipe(z.object({ rows: z.array(clientCreate).min(1).max(2000) }))) b: { rows: z.infer<typeof clientCreate>[] }) {
    return this.imp.commit(a, b.rows);
  }

  @Get('export') @Perm('clients', 'export')
  async export(@CurrentActor() a: RequestActor, @Query('format', new ZodPipe(z.enum(['csv', 'xlsx']).default('xlsx'))) format: 'csv' | 'xlsx', @Res() res: Response) {
    const f = await this.imp.export(a, format);
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(f.body);
  }
}
