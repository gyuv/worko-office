import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { TIME_STATUSES } from '@worko/domain';
import { z } from 'zod';
import { CurrentActor, Perm, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { TimeReportsService } from './reports.service.js';
import { TimeService, type EntriesQ, type EntryIn, type EntryPatch } from './time.service.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');
const uuidN = z.string().uuid().nullable().optional();
const entryB = z.object({
  taskId: uuidN, clientId: uuidN, workDate: date, minutes: z.number().int().min(1).max(1440), billable: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(), submit: z.boolean().optional(),
}).strict();
const entryPatchB = z.object({
  taskId: uuidN, clientId: uuidN, workDate: date.optional(), minutes: z.number().int().min(1).max(1440).optional(), billable: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(), status: z.enum(['draft', 'submitted']).optional(),
}).strict();
const listQ = z.object({
  userId: z.string().uuid().optional(), from: date.optional(), to: date.optional(), status: z.enum(TIME_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200), offset: z.coerce.number().int().min(0).default(0),
});
const decideB = z.object({ ids: z.array(z.string().uuid()).min(1).max(500), approve: z.boolean(), note: z.string().max(1000).nullable().optional() }).strict();
const reverseB = z.object({ note: z.string().trim().min(3).max(500) }).strict();
const weekB = z.object({ weekStart: date }).strict();
const startB = z.object({ taskId: uuidN, clientId: uuidN, notes: z.string().max(2000).nullable().optional(), billable: z.boolean().optional(), deviceAt: z.string().datetime({ offset: true }).nullable().optional() }).strict();
const stopB = z.object({ notes: z.string().max(2000).nullable().optional() }).strict();
const pnlQ = z.object({ from: date, to: date, groupBy: z.enum(['task', 'client', 'service']).default('task') }).refine((q) => q.from <= q.to, 'from after to');
const capQ = z.object({ weeks: z.coerce.number().int().min(1).max(26).default(4), from: date.optional() });

@Controller()
export class TimeController {
  constructor(private time: TimeService, private reports: TimeReportsService) {}

  @Get('time/entries') @Perm('time', 'view')
  list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listQ)) q: EntriesQ) { return this.time.list(a, q); }

  @Post('time/entries') @Perm('time', 'edit')
  create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(entryB)) b: EntryIn) { return this.time.create(a, b); }

  @Get('time/entries/:id') @Perm('time', 'view')
  get(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.time.get(a, id); }

  @Patch('time/entries/:id') @Perm('time', 'edit') @HttpCode(204)
  update(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(entryPatchB)) b: EntryPatch) { return this.time.update(a, id, b); }

  @Delete('time/entries/:id') @Perm('time', 'edit') @HttpCode(204)
  remove(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.time.remove(a, id); }

  // Approvers include managers by reporting line, who may hold only time:view; the service checks manager/approve scope.
  @Post('time/entries/decide') @Perm('time', 'view') @HttpCode(200)
  decide(@CurrentActor() a: RequestActor, @Body(new ZodPipe(decideB)) b: { ids: string[]; approve: boolean; note?: string | null }) { return this.time.decide(a, b); }

  @Post('time/entries/:id/reverse') @Perm('time', 'view')
  reverse(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(reverseB)) b: { note: string }) { return this.time.reverse(a, id, b.note); }

  @Post('time/timesheets/submit') @Perm('time', 'edit') @HttpCode(200)
  submitWeek(@CurrentActor() a: RequestActor, @Body(new ZodPipe(weekB)) b: { weekStart: string }) { return this.time.submitWeek(a, b.weekStart); }

  @Get('time/timer') @Perm('time', 'view')
  timer(@CurrentActor() a: RequestActor) { return this.time.timer(a); }

  @Post('time/timer/start') @Perm('time', 'edit')
  start(@CurrentActor() a: RequestActor, @Body(new ZodPipe(startB)) b: { taskId?: string | null; clientId?: string | null; notes?: string | null; billable?: boolean; deviceAt?: string | null }) { return this.time.start(a, b); }

  @Post('time/timer/stop') @Perm('time', 'edit') @HttpCode(200)
  stop(@CurrentActor() a: RequestActor, @Body(new ZodPipe(stopB)) b: { notes?: string | null }) { return this.time.stop(a, b); }

  @Get('activity/live') @Perm('time', 'view')
  live(@CurrentActor() a: RequestActor) { return this.time.live(a); }

  @Get('reports/job-pnl') @Perm('reports', 'view')
  pnl(@CurrentActor() a: RequestActor, @Query(new ZodPipe(pnlQ)) q: { from: string; to: string; groupBy: 'task' | 'client' | 'service' }) { return this.reports.jobPnl(a, q); }

  @Get('reports/capacity') @Perm('time', 'view')
  capacity(@CurrentActor() a: RequestActor, @Query(new ZodPipe(capQ)) q: { weeks: number; from?: string }) { return this.reports.capacity(a, q); }
}
