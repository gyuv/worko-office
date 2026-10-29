import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { COMM_CHANNELS, SUGGESTION_KINDS } from '@worko/domain';
import { z } from 'zod';
import { CurrentActor, Perm, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AiService } from './ai.service.js';

const uuid = z.string().uuid();
const month = z.string().regex(/^\d{4}-\d{2}$/);
const draftIn = z.object({ clientId: uuid, messageId: uuid.optional(), noticeId: uuid.optional(), channel: z.enum(COMM_CHANNELS).default('email'), instruction: z.string().trim().max(500).optional() }).strict()
  .refine((b) => !!b.messageId !== !!b.noticeId, { message: 'Give messageId or noticeId', path: ['messageId'] });
const summaryIn = z.object({ clientId: uuid, noticeId: uuid.optional() }).strict();
const classifyIn = z.object({ documentId: uuid }).strict();
const listQ = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'failed']).optional(), kind: z.enum(SUGGESTION_KINDS).optional(), clientId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50) });
const approveIn = z.object({ subject: z.string().trim().max(200).nullable().optional(), body: z.string().trim().min(1).max(4000).optional(), channel: z.enum(COMM_CHANNELS).optional(),
  category: z.string().trim().min(1).max(60).optional(), fy: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional() }).strict();
const rejectIn = z.object({ reason: z.string().trim().max(500).optional() }).strict();

/** M21 AI. Generating needs `ai:create` + the underlying data permission; approving needs what doing it by hand needs (D149). */
@Controller('ai')
export class AiController {
  constructor(private ai: AiService) {}
  @Get('settings') @Perm('settings', 'view') settings(@CurrentActor() a: RequestActor) { return this.ai.getSettings(a); }
  @Put('settings') @Perm('settings', 'edit') putSettings(@CurrentActor() a: RequestActor, @Body() b: unknown) { return this.ai.putSettings(a, b); }
  @Get('availability') @Perm('ai', 'view') availability(@CurrentActor() a: RequestActor) { return this.ai.availability(a); }
  @Get('usage') @Perm('settings', 'view') usage(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ month }))) q: { month: string }) { return this.ai.usage(a, q.month); }
  @Post('draft-reply') @Perm('ai', 'create') draft(@CurrentActor() a: RequestActor, @Body(new ZodPipe(draftIn)) b: z.infer<typeof draftIn>) { return this.ai.draftReply(a, b); }
  @Post('summaries') @Perm('ai', 'create') summarise(@CurrentActor() a: RequestActor, @Body(new ZodPipe(summaryIn)) b: z.infer<typeof summaryIn>) { return this.ai.summarise(a, b); }
  @Post('classify') @Perm('ai', 'create') classify(@CurrentActor() a: RequestActor, @Body(new ZodPipe(classifyIn)) b: z.infer<typeof classifyIn>) { return this.ai.classify(a, b.documentId); }
  @Get('suggestions') @Perm('ai', 'view') list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listQ)) q: z.infer<typeof listQ>) { return this.ai.list(a, q); }
  @Get('suggestions/:id') @Perm('ai', 'view') get(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.ai.get(a, id); }
  @Post('suggestions/:id/approve') @HttpCode(200) @Perm('ai', 'view')
  approve(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(approveIn)) b: z.infer<typeof approveIn>) { return this.ai.approve(a, id, b); }
  @Post('suggestions/:id/reject') @HttpCode(204) @Perm('ai', 'view')
  async reject(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(rejectIn)) b: z.infer<typeof rejectIn>) { await this.ai.reject(a, id, b.reason); }
}
