import { useQuery } from '@tanstack/react-query';
import type { Schemas } from '@worko/api-client';
import { api, unwrap } from '../../lib/session';
import type { Holiday, WorkWeek } from './logic';

/**
 * Typed views of the Phase 6 responses. The OpenAPI spec models many HR bodies as plain objects, so the shapes here mirror
 * the API presenters (apps/api/src/hr/*, apps/api/src/time/*) and requests are passed through as `never`.
 */
export const as = <T>(p: Promise<{ data?: unknown; error?: unknown; response: Response }>) => unwrap(p) as Promise<T>;
export const body = <T>(b: T) => b as never;

export type TimeEntry = Schemas['TimeEntry'];
export type Timer = { id: string; taskId: string | null; clientId: string | null; notes: string | null; billable: boolean; startedAt: string; deviceStartedAt: string | null } | null;
export type LiveItem = { userId: string; userName: string; startedAt: string; minutes: number; label: string; task: { id: string; title: string } | null; client: { id: string; name: string } | null; inScope: boolean };
export type CapacityCell = { weekStart: string; capacityMinutes: number; workDays: number; holidays: number; leaveDays: number; plannedMinutes: number; actualMinutes: number; plannedPct: number | null; actualPct: number | null };
export type Capacity = { from: string; to: string; weeks: string[]; users: Array<{ userId: string; name: string; weeklyCapacityMinutes: number; weeks: CapacityCell[] }> };

export type HrSettings = {
  attendance: { mode: 'none' | 'geofence' | 'ip' | 'either' | 'both'; outside: 'flag' | 'approval'; ipAllowList: string[]; skewFlagMinutes: number };
  workWeek: WorkWeek & { excludeWeekends: boolean; excludeHolidays: boolean };
  capacity: { defaultWeeklyMinutes: number };
  timer: { capMinutes: number };
  compOff: { enabled: boolean; typeKey: string; halfDayMinutes: number; fullDayMinutes: number; expiryDays: number };
};
export type HolidayRow = Holiday & { id: string };
export type OfficeLocation = { id: string; branchId: string | null; name: string; lat: number; lng: number; radiusM: number; active: boolean };
export type LeaveType = { id: string; key: string; name: string; paid: boolean; tracked: boolean; appliesToRoles: string[]; accrual: { kind: 'none' | 'monthly' | 'annual'; days: number }; carryForwardCap: number | null; allowHalfDay: boolean; maxDaysPerRequest: number | null; compOff: boolean; active: boolean; sort: number; notes: string | null };
export type ExpenseCategory = { id: string; key: string; name: string; limitPaise: number | null; limitMode: 'warn' | 'block'; active: boolean };
export type CostRate = { id: string; userId: string; userName: string; hourlyPaise: number; effectiveFrom: string; effectiveTo: string | null; notes: string | null };

export type Attendance = { id: string; userId: string; userName: string | null; date: string; checkInAt: string; checkOutAt: string | null; inFence: boolean | null; distanceM: number | null; ipOk: boolean | null; method: string; flags: string[]; status: string; minutes: number | null; notes: string | null };
export type Regularisation = { id: string; userId: string; userName: string | null; date: string; checkInAt: string; checkOutAt: string | null; reason: string; status: string; decisionNote: string | null };
export type AttendanceReport = { month: string; from: string; to: string; users: Array<{ userId: string; name: string; workingDays: number; holidays: number; presentDays: number; flaggedDays: number; pendingApproval: number; leaveDays: number; absentDays: number; minutes: number }> };

export type Balance = { leaveType: LeaveType; balance: number; pending: number; available: number; expiring: Array<{ days: number; expiresOn: string }> };
export type Balances = { userId: string; asOf: string; balances: Balance[] };
export type LedgerRow = { id: string; leaveTypeId: string; leaveTypeKey: string; delta: number; reason: string; refKey: string | null; requestId: string | null; on: string; expiresOn: string | null; note: string | null };
export type LeaveRequest = { id: string; userId: string; userName: string | null; leaveTypeId: string; leaveTypeKey: string | null; from: string; to: string; startHalf: boolean; endHalf: boolean; days: number; reason: string | null; status: string; approvedFrom: string | null; approvedTo: string | null; approvedDays: number | null; decisionNote: string | null };

export type Claim = { id: string; userId: string; userName: string | null; title: string; status: string; claimedPaise: number; approvedPaise: number | null; advanceSettledPaise: number; paidPaise: number; submittedAt: string | null; decisionNote: string | null; paidAt: string | null; payoutRef: string | null };
export type ClaimLineRow = { id: string; categoryKey: string; spentOn: string; description: string; amountPaise: number; approvedPaise: number | null; clientId: string | null; billable: boolean; receiptDocId: string | null; policyFlag: string | null; decisionNote: string | null; invoiceLineId: string | null };
export type ClaimDetail = Claim & { lines: ClaimLineRow[] };
export type Advance = { id: string; userId: string; userName: string | null; purpose: string; amountPaise: number; approvedPaise: number | null; status: string; balancePaise: number; paidAt: string | null; payoutRef: string | null };
export type Reimbursable = { totalPaise: number; items: Array<ClaimLineRow & { clientName: string | null; claimantName: string | null; suggestedLine: { description: string; ratePaise: number; reimbursement: true } }> };

export const useHrSettings = () => useQuery({ queryKey: ['hr', 'settings'], queryFn: () => as<HrSettings>(api.GET('/hr/settings')), staleTime: 60_000 });
export const useHolidays = (from?: string, to?: string) =>
  useQuery({ queryKey: ['hr', 'holidays', from ?? '', to ?? ''], queryFn: () => as<HolidayRow[]>(api.GET('/hr/holidays', { params: { query: { from, to } } })), staleTime: 60_000 });
export const useLeaveTypes = () => useQuery({ queryKey: ['hr', 'leave-types'], queryFn: () => as<LeaveType[]>(api.GET('/hr/leave-types')), staleTime: 60_000 });
export const useCategories = () => useQuery({ queryKey: ['hr', 'categories'], queryFn: () => as<ExpenseCategory[]>(api.GET('/hr/expense-categories')), staleTime: 60_000 });
