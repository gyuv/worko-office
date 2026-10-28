import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentActor, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { SyncService } from './sync.service.js';

const mutation = z.object({
  key: z.string().min(8).max(100), table: z.string().max(64), id: z.string().uuid(),
  baseVersion: z.number().int().min(0), patch: z.record(z.unknown()).default({}), delete: z.boolean().optional(),
});
const pushSchema = z.object({ mutations: z.array(mutation).min(1).max(200) });
const pullSchema = z.object({ since: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(500) });

/** Visibility and write rules are per table in the sync registry, so these routes need only authentication. */
@Controller('sync')
export class SyncController {
  constructor(private sync: SyncService) {}

  @Post('push') @HttpCode(200)
  async push(@CurrentActor() a: RequestActor, @Body(new ZodPipe(pushSchema)) b: z.infer<typeof pushSchema>) {
    return { results: await this.sync.push(a, b.mutations) };
  }

  @Get('pull')
  pull(@CurrentActor() a: RequestActor, @Query(new ZodPipe(pullSchema)) q: z.infer<typeof pullSchema>) {
    return this.sync.pull(a, q.since, q.limit);
  }

  @Get('conflicts')
  conflicts(@CurrentActor() a: RequestActor) { return this.sync.conflicts(a); }

  @Post('conflicts/:id/resolve') @HttpCode(204)
  async resolve(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ restore: z.boolean() }))) b: { restore: boolean }) {
    await this.sync.resolveConflict(a, id, b.restore);
  }
}
