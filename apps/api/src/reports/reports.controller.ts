import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Res } from '@nestjs/common';
import { dashboardWidgetsSchema } from '@worko/domain';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentActor, Perm, type RequestActor, Feature } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { NlQueryService } from './nlquery.service.js';
import { EXPORT_FORMATS } from './render.js';
import { ReportsService, shareSchema } from './reports.service.js';
import { ReportScheduleService } from './schedule.service.js';

const params = z.record(z.string().regex(/^[a-zA-Z]{1,20}$/), z.union([z.string().max(40), z.number().int()])).optional();
const source = { definition: z.unknown().optional(), reportId: z.string().uuid().optional(), catalogueKey: z.string().regex(/^[a-z0-9_]{2,60}$/).optional() };
const runIn = z.object({ ...source, params, drill: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).optional(),
  page: z.number().int().min(1).max(100_000).optional(), pageSize: z.number().int().min(1).max(500).optional() }).strict();
const exportIn = z.object({ ...source, params, format: z.enum(EXPORT_FORMATS), mode: z.enum(['rows', 'groups']).optional() }).strict();
const name = z.string().trim().min(1).max(120);
const savedIn = z.object({ name, description: z.string().trim().max(1000).nullable().optional(), definition: z.unknown(), share: shareSchema.optional() }).strict();
const savedPatch = z.object({ name: name.optional(), description: z.string().trim().max(1000).nullable().optional(), definition: z.unknown().optional() }).strict();
const dashIn = z.object({ name, widgets: dashboardWidgetsSchema, roleKey: z.string().regex(/^[a-z_]{2,40}$/).nullable().optional() }).strict();
const dashPatch = z.object({ name: name.optional(), widgets: dashboardWidgetsSchema.optional() }).strict();
const defaultIn = z.object({ dashboardId: z.string().uuid().nullable() }).strict();
const schedBase = { name, params, schedule: z.unknown(), recipientIds: z.array(z.string().uuid()).min(1).max(50), delivery: z.enum(['email', 'in_app']).optional(),
  format: z.enum(EXPORT_FORMATS).optional(), linkTtlDays: z.number().int().min(1).max(30).optional() };
const schedIn = z.object({ ...schedBase, reportId: z.string().uuid().optional(), catalogueKey: z.string().regex(/^[a-z0-9_]{2,60}$/).optional() }).strict()
  .refine((b) => !!b.reportId !== !!b.catalogueKey, { message: 'Give reportId or catalogueKey', path: ['reportId'] });
const schedPatch = z.object({ name: name.optional(), params, schedule: z.unknown().optional(), recipientIds: schedBase.recipientIds.optional(), delivery: schedBase.delivery, format: schedBase.format,
  linkTtlDays: schedBase.linkTtlDays, enabled: z.boolean().optional() }).strict();
const askIn = z.object({ question: z.string().trim().min(3).max(500), run: z.boolean().optional() }).strict();
const askSave = z.object({ name }).strict();
const token = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/);

/** M17 dashboards & reports + M21 NL query. Every run applies the VIEWER's scope (D161); datasets also need their source module's view. */
@Controller('reports')
@Feature('reports') // switchable module (M22, D182)
export class ReportsController {
  constructor(private reports: ReportsService, private schedules: ReportScheduleService, private nl: NlQueryService) {}

  @Get('datasets') @Perm('reports', 'view') datasets(@CurrentActor() a: RequestActor) { return this.reports.datasets(a); }
  @Get('catalogue') @Perm('reports', 'view') catalogue(@CurrentActor() a: RequestActor) { return this.reports.catalogue(a); }
  @Post('run') @HttpCode(200) @Perm('reports', 'view') run(@CurrentActor() a: RequestActor, @Body(new ZodPipe(runIn)) b: z.infer<typeof runIn>) { return this.reports.run(a, b); }
  @Post('export') @HttpCode(200) @Perm('reports', 'export')
  async export(@CurrentActor() a: RequestActor, @Body(new ZodPipe(exportIn)) b: z.infer<typeof exportIn>, @Res() res: Response) {
    const f = await this.reports.export(a, b);
    res.setHeader('Content-Type', f.mime); res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`); res.setHeader('Cache-Control', 'no-store');
    res.send(f.body);
  }
  @Get('downloads/:token') @Perm('reports', 'view')
  async download(@CurrentActor() a: RequestActor, @Param('token', new ZodPipe(token)) t: string, @Res() res: Response) {
    const f = await this.reports.download(a, t);
    res.setHeader('Content-Type', f.mime); res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`); res.setHeader('Cache-Control', 'no-store');
    res.send(f.body);
  }

  @Get('exports/:id/download') @Perm('reports', 'view')
  async downloadById(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const f = await this.reports.downloadById(a, id);
    res.setHeader('Content-Type', f.mime); res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`); res.setHeader('Cache-Control', 'no-store');
    res.send(f.body);
  }

  @Get('saved') @Perm('reports', 'view') list(@CurrentActor() a: RequestActor) { return this.reports.list(a); }
  @Post('saved') @Perm('reports', 'create') create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(savedIn)) b: z.infer<typeof savedIn>) { return this.reports.create(a, b); }
  @Get('saved/:id') @Perm('reports', 'view') get(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.reports.get(a, id); }
  @Put('saved/:id') @Perm('reports', 'edit') update(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(savedPatch)) b: z.infer<typeof savedPatch>) { return this.reports.update(a, id, b); }
  @Delete('saved/:id') @HttpCode(204) @Perm('reports', 'edit') async remove(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.reports.remove(a, id); }
  @Get('saved/:id/versions') @Perm('reports', 'view') versions(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.reports.versions(a, id); }
  @Put('saved/:id/share') @Perm('reports', 'edit') share(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(shareSchema)) b: z.infer<typeof shareSchema>) { return this.reports.share(a, id, b); }

  @Get('dashboards') @Perm('reports', 'view') dashboards(@CurrentActor() a: RequestActor) { return this.reports.dashboards(a); }
  @Post('dashboards') @Perm('reports', 'create') createDashboard(@CurrentActor() a: RequestActor, @Body(new ZodPipe(dashIn)) b: z.infer<typeof dashIn>) { return this.reports.createDashboard(a, b); }
  @Get('dashboards/default') @Perm('reports', 'view') defaultDashboard(@CurrentActor() a: RequestActor) { return this.reports.defaultDashboard(a); }
  @Put('dashboards/default') @Perm('reports', 'view') setDefault(@CurrentActor() a: RequestActor, @Body(new ZodPipe(defaultIn)) b: z.infer<typeof defaultIn>) { return this.reports.setDefault(a, b.dashboardId); }
  @Get('dashboards/default/data') @Perm('reports', 'view') defaultData(@CurrentActor() a: RequestActor) { return this.reports.dashboardData(a, 'default'); }
  @Get('dashboards/:id') @Perm('reports', 'view') getDashboard(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.reports.getDashboard(a, id); }
  @Put('dashboards/:id') @Perm('reports', 'edit') updateDashboard(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(dashPatch)) b: z.infer<typeof dashPatch>) { return this.reports.updateDashboard(a, id, b); }
  @Delete('dashboards/:id') @HttpCode(204) @Perm('reports', 'edit') async removeDashboard(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.reports.removeDashboard(a, id); }
  @Get('dashboards/:id/data') @Perm('reports', 'view') dashboardData(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.reports.dashboardData(a, id); }

  @Get('schedules') @Perm('reports', 'view') schedulesList(@CurrentActor() a: RequestActor) { return this.schedules.list(a); }
  @Post('schedules') @Perm('reports', 'create') createSchedule(@CurrentActor() a: RequestActor, @Body(new ZodPipe(schedIn)) b: z.infer<typeof schedIn>) { return this.schedules.create(a, b); }
  @Get('schedules/:id') @Perm('reports', 'view') getSchedule(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.schedules.get(a, id); }
  @Put('schedules/:id') @Perm('reports', 'edit') updateSchedule(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(schedPatch)) b: z.infer<typeof schedPatch>) { return this.schedules.update(a, id, b); }
  @Delete('schedules/:id') @HttpCode(204) @Perm('reports', 'edit') async removeSchedule(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.schedules.remove(a, id); }
  @Get('schedules/:id/runs') @Perm('reports', 'view') scheduleRuns(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.schedules.runs(a, id); }

  @Post('ask') @HttpCode(200) @Perm('reports', 'view') ask(@CurrentActor() a: RequestActor, @Body(new ZodPipe(askIn)) b: z.infer<typeof askIn>) { return this.nl.ask(a, b); }
  @Get('ask') @Perm('reports', 'view') askHistory(@CurrentActor() a: RequestActor) { return this.nl.history(a); }
  @Post('ask/:id/save') @Perm('reports', 'create') askSave(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(askSave)) b: z.infer<typeof askSave>) { return this.nl.save(a, id, b); }
}
