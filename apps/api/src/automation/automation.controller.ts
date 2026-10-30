import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentActor, Perm, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AutomationService } from './automation.service.js';

const uuid = z.string().uuid();
const txt = (n: number) => z.string().trim().min(1).max(n);
const ruleIn = z.object({ name: txt(200), description: z.string().trim().max(1000).nullable().optional(), scope: z.enum(['firm', 'personal']).default('firm'),
  definition: z.unknown(), enabled: z.boolean().optional() }).strict();
const rulePatch = z.object({ name: txt(200).optional(), description: z.string().trim().max(1000).nullable().optional(), definition: z.unknown().optional(), note: z.string().max(300).optional() }).strict();
const sample = { limit: z.number().int().min(1).max(100).default(20), entityType: z.string().max(40).optional(), entityId: uuid.optional() };
const dryRunIn = z.object({ ...sample, definition: z.unknown().optional() }).strict();
const draftDryRunIn = z.object({ ...sample, scope: z.enum(['firm', 'personal']).default('firm'), definition: z.unknown() }).strict();
const retryIn = z.object({ expectedAttempts: z.number().int().min(0).optional() }).strict().optional();
const agentIn = z.object({ params: z.record(z.unknown()).optional(), name: txt(200).optional(), enabled: z.boolean().optional() }).strict();
const agentPreviewIn = z.object({ params: z.record(z.unknown()).optional(), limit: z.number().int().min(1).max(100).default(20) }).strict();
const listQ = z.object({ scope: z.enum(['firm', 'personal']).optional(), enabled: z.enum(['true', 'false']).transform((v) => v === 'true').optional() });
const runsQ = z.object({ ruleId: uuid.optional(), status: z.enum(['running', 'succeeded', 'partial', 'failed', 'skipped', 'no_match']).optional(),
  before: z.string().datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const agentKey = new ZodPipe(z.string().regex(/^[a-z_]{2,40}$/));

/** M15 automation (REST-only). Row-level rules (firm vs personal, owner) are checked in the service (D142). */
@Controller('automation')
export class AutomationController {
  constructor(private svc: AutomationService) {}
  @Get('rules') @Perm('automation', 'view') list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listQ)) q: z.infer<typeof listQ>) { return this.svc.list(a, q); }
  @Post('rules') @Perm('automation', 'create') create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(ruleIn)) b: z.infer<typeof ruleIn>) { return this.svc.create(a, b); }
  @Post('dry-run') @HttpCode(200) @Perm('automation', 'view') draft(@CurrentActor() a: RequestActor, @Body(new ZodPipe(draftDryRunIn)) b: z.infer<typeof draftDryRunIn>) { return this.svc.dryRunDraft(a, b); }
  @Get('rules/:id') @Perm('automation', 'view') get(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(a, id); }
  @Patch('rules/:id') @Perm('automation', 'edit') update(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(rulePatch)) b: z.infer<typeof rulePatch>) { return this.svc.update(a, id, b); }
  @Delete('rules/:id') @HttpCode(204) @Perm('automation', 'edit') async remove(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.svc.setState(a, id, 'delete'); }
  @Post('rules/:id/enable') @HttpCode(200) @Perm('automation', 'edit') enable(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.setState(a, id, 'enable'); }
  @Post('rules/:id/disable') @HttpCode(200) @Perm('automation', 'edit') disable(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.setState(a, id, 'disable'); }
  @Post('rules/:id/resume') @HttpCode(200) @Perm('automation', 'edit') resume(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.setState(a, id, 'resume'); }
  @Get('rules/:id/versions') @Perm('automation', 'view') versions(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.versions(a, id); }
  @Post('rules/:id/dry-run') @HttpCode(200) @Perm('automation', 'view')
  dryRun(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(dryRunIn)) b: z.infer<typeof dryRunIn>) { return this.svc.dryRunRule(a, id, b); }
  @Get('agents') @Perm('automation', 'view') agents() { return this.svc.agents(); }
  @Post('agents/:key/preview') @HttpCode(200) @Perm('automation', 'view')
  previewAgent(@CurrentActor() a: RequestActor, @Param('key', agentKey) key: string, @Body(new ZodPipe(agentPreviewIn)) b: z.infer<typeof agentPreviewIn>) { return this.svc.previewAgent(a, key, b); }
  @Post('agents/:key/enable') @Perm('automation', 'create')
  enableAgent(@CurrentActor() a: RequestActor, @Param('key', agentKey) key: string, @Body(new ZodPipe(agentIn)) b: z.infer<typeof agentIn>) { return this.svc.enableAgent(a, key, b); }
  @Get('runs') @Perm('automation', 'view') runs(@CurrentActor() a: RequestActor, @Query(new ZodPipe(runsQ)) q: z.infer<typeof runsQ>) { return this.svc.runs(a, q); }
  @Get('runs/:id') @Perm('automation', 'view') run(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.svc.getRun(a, id); }
  /** Generation token: body `expectedAttempts` or an integer `Idempotency-Key` header (the run's `attempts` the caller saw); omitted = current. */
  @Post('runs/:id/retry') @HttpCode(200) @Perm('automation', 'edit')
  retry(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(retryIn)) b: z.infer<typeof retryIn>, @Headers('idempotency-key') key?: string) {
    const fromKey = key !== undefined && /^\d{1,9}$/.test(key) ? Number(key) : undefined;
    return this.svc.retryRun(a, id, b?.expectedAttempts ?? fromKey);
  }
  @Get('settings') @Perm('automation', 'view') settings(@CurrentActor() a: RequestActor) { return this.svc.settings(a); }
  @Put('settings') @Perm('settings', 'edit') putSettings(@CurrentActor() a: RequestActor, @Body() b: unknown) { return this.svc.putSettings(a, b); }
  @Get('costs') @Perm('automation', 'view') costs(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }))) q: { month?: string }) { return this.svc.costs(a, q.month); }
}
