import { useQuery } from '@tanstack/react-query';
import type { ColumnType, DashboardWidget, FilterOp, ParamSpec, ReportDefinition, ReportGroup, ReportSchedule } from '@worko/domain';
import { apiBase } from '../../lib/platform';
import { api, useSession } from '../../lib/session';
import { as, asFull, body } from '../leads/api';
import type { CatalogueItem, ResultColumn, RunResult } from './logic';

/** Typed views of the Phase 11 report responses (apps/api/src/reports/*); the spec models most of them as plain objects. */
export { as, asFull, body };
export type { RunResult };

export type DatasetColumn = { key: string; label: string; type: ColumnType; description: string | null; values: string[] | null; sensitivity: string | null; ref: string | null; hidden: boolean; ops: FilterOp[] };
export type Dataset = { key: string; label: string; description: string; module: string; entity: string | null; params: ParamSpec[]; columns: DatasetColumn[] };
export type Share = { firm?: boolean; roles?: string[]; userIds?: string[] };
export type SavedReport = { id: string; name: string; description: string | null; ownerId: string; ownerName: string | null; definition: ReportDefinition; explanation: string;
  currentVersion: number; source: string; catalogueKey: string | null; share: Share; canEdit: boolean; createdAt: string; updatedAt: string; version: number };
export type SavedVersion = { reportVersion: number; name: string; definition: ReportDefinition; changedBy: string | null; changedAt: string };
export type Dashboard = { id: string | null; name: string | null; ownerId: string | null; roleKey: string | null; widgets: DashboardWidget[]; canEdit: boolean; origin?: 'user' | 'role' | 'template' | 'none'; version?: number };
export type WidgetData = { id: string; kind: 'kpi' | 'chart' | 'table'; title: string; error?: string; dataset?: string; explanation?: string; hiddenColumns?: string[]; asOf?: string;
  value?: number | string | null; valueKey?: string; type?: ColumnType | null; chart?: string; groups?: ReportGroup[]; totals?: Record<string, number | string | null>;
  columns?: ResultColumn[]; rows?: RunResult['rows']; rowCount?: number };
export type DashboardData = { dashboard: Dashboard; widgets: WidgetData[] };
export type Schedule = { id: string; name: string; ownerId: string; reportId: string | null; catalogueKey: string | null; params: Record<string, string | number> | null; schedule: ReportSchedule;
  recipientIds: string[]; delivery: 'email' | 'in_app'; format: 'csv' | 'xlsx' | 'pdf'; linkTtlDays: number; enabled: boolean; status: string; pausedReason: string | null;
  consecutiveFailures: number; nextRunAt: string | null; lastRunAt: string | null; version: number };
export type ScheduleRun = { id: string; periodKey: string; recipientId: string; recipientName: string | null; status: 'running' | 'delivered' | 'skipped' | 'failed'; skipReason: string | null;
  rowCount: number | null; error: string | null; occurrenceAt: string; startedAt: string; finishedAt: string | null };
export type Source = { definition?: ReportDefinition; reportId?: string; catalogueKey?: string };
export type AskAnswer = { id: string; status: string; definition: ReportDefinition; explanation: string; sources: Array<{ type: string; key: string; label: string; columns: string[] }>;
  provider: string; model: string; mock: boolean; costPaise: number; result: RunResult | null };
export type AskHistory = { id: string; question: string; status: string; definition: ReportDefinition | null; explanation: string | null; sources: AskAnswer['sources']; issues: string[];
  provider: string | null; savedReportId: string | null; createdAt: string };

export const useDatasets = () => useQuery({ queryKey: ['reports', 'datasets'], staleTime: 300_000, queryFn: () => as<Dataset[]>(api.GET('/reports/datasets')) });
export const useCatalogue = () => useQuery({ queryKey: ['reports', 'catalogue'], staleTime: 300_000, queryFn: () => as<CatalogueItem[]>(api.GET('/reports/catalogue')) });
export const useSaved = () => useQuery({ queryKey: ['reports', 'saved'], queryFn: () => as<{ items: SavedReport[] }>(api.GET('/reports/saved')).then((r) => r.items) });
export const useSchedules = () => useQuery({ queryKey: ['reports', 'schedules'], queryFn: () => as<{ items: Schedule[] }>(api.GET('/reports/schedules')).then((r) => r.items) });

export const runReport = (b: Source & { params?: Record<string, string | number>; drill?: Record<string, unknown>; page?: number; pageSize?: number }) =>
  asFull<RunResult>(api.POST('/reports/run', { body: body(b) }));

/** POST /reports/export → file (the typed client does not model binary bodies). Keeps the error code for 403 export_forbidden. */
export async function exportReport(b: Source & { params?: Record<string, string | number>; format: 'csv' | 'xlsx' | 'pdf'; mode?: 'rows' | 'groups' }): Promise<{ blob: Blob; filename: string | null }> {
  const tokens = useSession.getState().tokens;
  const res = await fetch(`${apiBase()}/reports/export`, { method: 'POST', body: JSON.stringify(b),
    headers: { 'content-type': 'application/json', ...(tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {}) } });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
    throw Object.assign(new Error(e.message ?? `HTTP ${res.status}`), { status: res.status, code: e.code, body: e });
  }
  const filename = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? null;
  return { blob: await res.blob(), filename };
}
