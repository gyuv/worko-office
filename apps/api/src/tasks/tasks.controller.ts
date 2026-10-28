import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { SERVICE_FREQUENCIES, TASK_OUTCOMES, TASK_PRIORITIES, TASK_STATUSES } from '@worko/domain';
import { z } from 'zod';
import { CurrentActor, Perm, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { checkSchema, SYNC_TABLES } from '../sync/registry.js';
import { AutoTaskService } from './auto.service.js';
import { CatalogueService, type ClientServiceIn, type ServiceTypeIn } from './catalogue.service.js';
import { TasksService } from './tasks.service.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const uuidN = z.string().uuid().nullable().optional();
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const listQ = z.object({
  status: z.string().max(200).transform((s) => s.split(',').filter(Boolean)).pipe(z.array(z.enum(TASK_STATUSES))).optional(),
  assigneeId: z.union([z.literal('me'), z.string().uuid()]).optional(), clientId: z.string().uuid().optional(), serviceTypeId: z.string().uuid().optional(),
  dueFrom: date.optional(), dueTo: date.optional(), overdue: bool.optional(), asOf: date.optional(), closed: bool.optional(), firm: bool.optional(),
  q: z.string().max(100).optional(), dateField: z.enum(['statutory_due', 'act_by']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200), offset: z.coerce.number().int().min(0).default(0),
});
const calQ = z.object({ from: date, to: date, field: z.enum(['statutory_due', 'act_by']).default('statutory_due') });
// Same validation as device sync (the registry's writable schemas); server columns (outcome, source…) are refused.
const taskWritable = z.object(SYNC_TABLES.task!.writable).partial().strict();
const taskCreate = taskWritable.required({ title: true });
const taskPatch = taskWritable.omit({ client_id: true, service_type_id: true, period_key: true });
const bulkB = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  patch: z.object({ status: z.enum(TASK_STATUSES), assignee_id: z.string().uuid().nullable(), reviewer_id: z.string().uuid().nullable(), act_by: date.nullable(), priority: z.enum(TASK_PRIORITIES) })
    .partial().strict().refine((p) => Object.keys(p).length > 0, 'Empty patch'),
});
const autoB = z.object({ month });
const closeB = z.object({ outcome: z.enum(TASK_OUTCOMES), note: z.string().max(1000).nullable().optional() });
const checkB = z.object({ key: z.string().max(40), done: z.boolean() });
const serviceB = z.object({
  key: z.string().regex(/^[A-Z0-9_]{2,40}$/), name: z.string().trim().min(1).max(200), category: z.string().trim().min(1).max(100).default('Compliance'),
  description: z.string().max(2000).nullable().optional(), frequency: z.enum(SERVICE_FREQUENCIES), ruleId: z.string().max(100).nullable().optional(),
  slaDays: z.number().int().min(0).max(365).nullable().optional(), defaultChecks: z.array(checkSchema.pick({ key: true, label: true, required: true })).max(50).optional(),
  leaderId: uuidN, managerId: uuidN, reviewerId: uuidN, assigneeId: uuidN, billable: z.boolean().optional(), active: z.boolean().optional(),
}).strict();
const subB = z.object({
  active: z.boolean().optional(), startPeriod: month.nullable().optional(), endPeriod: month.nullable().optional(),
  leaderId: uuidN, managerId: uuidN, reviewerId: uuidN, assigneeId: uuidN, notes: z.string().max(2000).nullable().optional(),
}).strict();
const todoWritable = z.object(SYNC_TABLES.todo!.writable).partial().strict();
const templateB = z.object({ name: z.string().trim().min(1).max(200), items: z.array(z.object({ title: z.string().trim().min(1).max(300), offsetDays: z.number().int().min(-365).max(365).default(0) })).min(1).max(100) });
const applyB = z.object({ baseDate: date.optional(), taskId: z.string().uuid().nullable().optional() });

@Controller()
export class TasksController {
  constructor(private tasks: TasksService, private auto: AutoTaskService, private catalogue: CatalogueService) {}

  // ---------- Service catalogue ----------
  @Get('service-types') @Perm('tasks', 'view')
  serviceTypes(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ all: bool.optional() }))) q: { all?: boolean }) { return this.catalogue.list(a, q.all); }

  @Post('service-types') @Perm('settings', 'edit')
  createServiceType(@CurrentActor() a: RequestActor, @Body(new ZodPipe(serviceB)) b: ServiceTypeIn) { return this.catalogue.create(a, b); }

  @Patch('service-types/:id') @HttpCode(204) @Perm('settings', 'edit')
  async updateServiceType(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(serviceB.partial())) b: ServiceTypeIn) { await this.catalogue.update(a, id, b); }

  @Post('service-types/install-defaults') @HttpCode(200) @Perm('settings', 'edit')
  installDefaults(@CurrentActor() a: RequestActor) { return this.catalogue.installDefaults(a); }

  @Get('clients/:id/services') @Perm('tasks', 'view')
  clientServices(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.catalogue.listForClient(a, id); }

  @Put('clients/:id/services/:serviceTypeId') @Perm('tasks', 'assign')
  subscribe(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Param('serviceTypeId', ParseUUIDPipe) st: string, @Body(new ZodPipe(subB)) b: ClientServiceIn) {
    return this.catalogue.subscribe(a, id, st, b);
  }

  // ---------- Tasks ----------
  @Get('tasks') @Perm('tasks', 'view')
  list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listQ)) q: z.infer<typeof listQ>) { return this.tasks.list(a, q); }

  @Get('tasks/calendar') @Perm('tasks', 'view')
  calendar(@CurrentActor() a: RequestActor, @Query(new ZodPipe(calQ)) q: z.infer<typeof calQ>) { return this.tasks.calendar(a, q.from, q.to, q.field); }

  @Post('tasks') @Perm('tasks', 'create')
  create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(taskCreate)) b: Record<string, unknown>) { return this.tasks.create(a, b); }

  @Post('tasks/bulk') @HttpCode(200) @Perm('tasks', 'edit')
  bulk(@CurrentActor() a: RequestActor, @Body(new ZodPipe(bulkB)) b: z.infer<typeof bulkB>) { return this.tasks.bulk(a, b.ids, b.patch); }

  @Post('tasks/bulk/undo') @HttpCode(200) @Perm('tasks', 'edit')
  undo(@CurrentActor() a: RequestActor, @Body(new ZodPipe(z.object({ undoToken: z.string().uuid() }))) b: { undoToken: string }) { return this.tasks.undo(a, b.undoToken); }

  @Post('tasks/auto/preview') @HttpCode(200) @Perm('tasks', 'create')
  autoPreview(@CurrentActor() a: RequestActor, @Body(new ZodPipe(autoB)) b: { month: string }) { return this.auto.preview(a, b.month); }

  @Post('tasks/auto/commit') @HttpCode(200) @Perm('tasks', 'create')
  autoCommit(@CurrentActor() a: RequestActor, @Body(new ZodPipe(autoB)) b: { month: string }) { return this.auto.commit(a, b.month); }

  @Get('tasks/:id') @Perm('tasks', 'view')
  get(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.tasks.get(a, id); }

  @Patch('tasks/:id') @HttpCode(204) @Perm('tasks', 'edit')
  async update(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(taskPatch)) b: Record<string, unknown>) { await this.tasks.update(a, id, b); }

  @Post('tasks/:id/checks') @HttpCode(204) @Perm('tasks', 'edit')
  async check(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(checkB)) b: z.infer<typeof checkB>) { await this.tasks.setCheck(a, id, b.key, b.done); }

  @Post('tasks/:id/close') @HttpCode(204) @Perm('tasks', 'edit')
  async close(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(closeB)) b: z.infer<typeof closeB>) { await this.tasks.close(a, id, b.outcome, b.note); }

  // ---------- To-dos: personal, so any signed-in staff user (no module permission) ----------
  @Get('todos')
  todos(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ done: bool.optional(), taskId: z.string().uuid().optional() }))) q: { done?: boolean; taskId?: string }) { return this.tasks.listTodos(a, q); }

  @Post('todos')
  createTodo(@CurrentActor() a: RequestActor, @Body(new ZodPipe(todoWritable.required({ title: true }))) b: Record<string, unknown>) { return this.tasks.createTodo(a, b); }

  @Patch('todos/:id') @HttpCode(204)
  async updateTodo(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(todoWritable)) b: Record<string, unknown>) { await this.tasks.updateTodo(a, id, b); }

  @Delete('todos/:id') @HttpCode(204)
  async deleteTodo(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.tasks.updateTodo(a, id, null); }

  @Get('todo-templates') @Perm('tasks', 'view')
  templates(@CurrentActor() a: RequestActor) { return this.tasks.listTemplates(a); }

  @Post('todo-templates') @Perm('tasks', 'create')
  createTemplate(@CurrentActor() a: RequestActor, @Body(new ZodPipe(templateB)) b: z.infer<typeof templateB>) { return this.tasks.createTemplate(a, b); }

  @Post('todo-templates/:id/apply') @Perm('tasks', 'view')
  applyTemplate(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(applyB)) b: z.infer<typeof applyB>) { return this.tasks.applyTemplate(a, id, b); }
}
