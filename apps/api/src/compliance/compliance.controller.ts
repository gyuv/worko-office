import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { predicateSchema } from '@worko/rules';
import { z } from 'zod';
import { CurrentActor, Perm, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ComplianceService } from './compliance.service.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');
const extB = z.object({
  ruleId: z.string().max(100), periodKey: z.string().max(30), newDueDate: date, scope: predicateSchema.optional(), notification: z.string().max(500).nullable().optional(),
});
const matrixQ = z.object({ from: date, to: date, asOf: date.optional(), ruleIds: z.string().max(2000).transform((s) => s.split(',').filter(Boolean)).optional() });
const lateFeeB = z.object({
  ruleId: z.string().max(100), dueDate: date, filedOn: date, taxAmountPaise: z.number().int().min(0).max(1e15).optional(), nilReturn: z.boolean().optional(),
});

@Controller('compliance')
export class ComplianceController {
  constructor(private c: ComplianceService) {}

  @Get('packs') @Perm('compliance', 'view')
  packs(@CurrentActor() a: RequestActor) { return this.c.listPacks(a); }

  @Post('packs') @Perm('compliance', 'edit')
  upload(@CurrentActor() a: RequestActor, @Body(new ZodPipe(z.object({ pack: z.unknown() }))) b: { pack: unknown }) { return this.c.uploadPack(a, b.pack); }

  @Get('packs/:id/diff') @Perm('compliance', 'view')
  diff(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(z.object({ fy: z.coerce.number().int().min(2017).max(2100).optional() }))) q: { fy?: number }) {
    return this.c.diffPack(a, id, q.fy);
  }

  @Post('packs/:id/approve') @HttpCode(204) @Perm('compliance', 'approve')
  async approvePack(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.c.approvePack(a, id); }

  @Get('extensions') @Perm('compliance', 'view')
  extensions(@CurrentActor() a: RequestActor) { return this.c.listExtensions(a); }

  @Post('extensions') @Perm('compliance', 'edit')
  createExtension(@CurrentActor() a: RequestActor, @Body(new ZodPipe(extB)) b: z.infer<typeof extB>) { return this.c.createExtension(a, b); }

  @Get('extensions/:id/impact') @Perm('compliance', 'view')
  impact(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.c.impact(a, id); }

  @Post('extensions/:id/approve') @HttpCode(200) @Perm('compliance', 'approve')
  approveExtension(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.c.approveExtension(a, id); }

  @Get('matrix') @Perm('compliance', 'view')
  matrix(@CurrentActor() a: RequestActor, @Query(new ZodPipe(matrixQ)) q: z.infer<typeof matrixQ>) { return this.c.matrix(a, q); }

  @Post('late-fee') @HttpCode(200) @Perm('compliance', 'view')
  lateFee(@Body(new ZodPipe(lateFeeB)) b: z.infer<typeof lateFeeB>) { return this.c.lateFee(b); }
}
