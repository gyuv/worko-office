import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { accrualSchema, ATTENDANCE_STATUSES, CLAIM_STATUSES, LEAVE_STATUSES } from '@worko/domain';
import { z } from 'zod';
import { ClientIp, CurrentActor, Perm, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AttendanceService } from './attendance.service.js';
import { HrConfigService, type LeaveTypeIn } from './config.service.js';
import { ExpensesService, type ExpenseLineIn } from './expenses.service.js';
import { LeaveService } from './leave.service.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const paise = z.number().int().min(0).max(1e13);
const uuidN = z.string().uuid().nullable().optional();
const note = z.string().max(1000).nullable().optional();
const halfDays = z.number().multipleOf(0.5);

const holidayB = z.object({ date, name: z.string().trim().min(1).max(200), branchId: uuidN, optional: z.boolean().optional() }).strict();
const locationB = z.object({ branchId: uuidN, name: z.string().trim().min(1).max(200), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), radiusM: z.number().int().min(10).max(5000), active: z.boolean().optional() }).strict();
const locationPatchB = locationB.partial().extend({ deleted: z.boolean().optional() }).strict();
const leaveTypeB = z.object({
  key: z.string().regex(/^[a-z0-9_]{2,40}$/), name: z.string().trim().min(1).max(100), paid: z.boolean().optional(), tracked: z.boolean().optional(),
  appliesToRoles: z.array(z.string().max(40)).max(20).optional(), accrual: accrualSchema.optional(), carryForwardCap: halfDays.min(0).max(365).nullable().optional(),
  allowHalfDay: z.boolean().optional(), maxDaysPerRequest: halfDays.min(0.5).max(365).nullable().optional(), compOff: z.boolean().optional(), active: z.boolean().optional(),
  sort: z.number().int().min(0).max(1000).optional(), notes: z.string().max(1000).nullable().optional(),
}).strict();
const categoryB = z.object({ key: z.string().regex(/^[a-z0-9_]{2,40}$/), name: z.string().trim().min(1).max(100), limitPaise: paise.nullable().optional(), limitMode: z.enum(['warn', 'block']).optional(), active: z.boolean().optional() }).strict();
const costB = z.object({ userId: z.string().uuid(), hourlyPaise: paise, effectiveFrom: date, notes: z.string().max(500).nullable().optional() }).strict();
const capacityB = z.object({ weeklyMinutes: z.number().int().min(0).max(10_080) }).strict();
const checkInB = z.object({ lat: z.number().min(-90).max(90).nullable().optional(), lng: z.number().min(-180).max(180).nullable().optional(), deviceAt: z.string().datetime({ offset: true }).nullable().optional(), notes: z.string().max(500).nullable().optional() }).strict();
const checkOutB = checkInB.omit({ notes: true });
const decideB = z.object({ approve: z.boolean(), note }).strict();
const regB = z.object({ date, checkIn: hhmm, checkOut: hhmm.nullable().optional(), reason: z.string().trim().min(3).max(500) }).strict();
const attQ = z.object({ userId: z.string().uuid().optional(), from: date.optional(), to: date.optional(), status: z.enum(ATTENDANCE_STATUSES).optional() });
const applyB = z.object({ leaveTypeId: z.string().uuid(), from: date, to: date, startHalf: z.boolean().optional(), endHalf: z.boolean().optional(), reason: z.string().max(1000).nullable().optional() }).strict();
const leaveDecideB = z.object({ approve: z.boolean(), approvedFrom: date.optional(), approvedTo: date.optional(), startHalf: z.boolean().optional(), endHalf: z.boolean().optional(), note }).strict();
const leaveQ = z.object({ userId: z.string().uuid().optional(), status: z.enum(LEAVE_STATUSES).optional(), from: date.optional(), to: date.optional() });
const adjustB = z.object({ userId: z.string().uuid(), leaveTypeId: z.string().uuid(), delta: halfDays.min(-365).max(365).refine((x) => x !== 0, 'Zero'), reason: z.enum(['opening', 'grant', 'adjustment']), note: z.string().trim().min(3).max(500), expiresOn: date.nullable().optional() }).strict();
const rangeB = z.object({ from: date, to: date }).strict().refine((r) => r.from <= r.to, 'from after to');
const lineB = z.object({ categoryKey: z.string().regex(/^[a-z0-9_]{2,40}$/), spentOn: date, description: z.string().trim().min(1).max(500), amountPaise: paise.refine((x) => x > 0), clientId: uuidN, billable: z.boolean().optional(), receiptDocId: uuidN }).strict();
const claimB = z.object({ title: z.string().trim().min(1).max(200), lines: z.array(lineB).min(1).max(100), submit: z.boolean().optional() }).strict();
const claimPatchB = z.object({ title: z.string().trim().min(1).max(200).optional(), lines: z.array(lineB).min(1).max(100).optional() }).strict();
const claimDecideB = z.object({ approve: z.boolean(), lines: z.array(z.object({ id: z.string().uuid(), approvedPaise: paise, note }).strict()).max(100).optional(), note }).strict();
const payB = z.object({ reference: z.string().trim().min(1).max(100) }).strict();
const advanceB = z.object({ purpose: z.string().trim().min(3).max(500), amountPaise: paise.refine((x) => x > 0) }).strict();
const advDecideB = z.object({ approve: z.boolean(), approvedPaise: paise.optional(), note }).strict();
const linkB = z.object({ invoiceLineId: z.string().uuid() }).strict();
const userQ = z.object({ userId: z.string().uuid().optional() });

@Controller('hr')
export class HrController {
  constructor(private config: HrConfigService, private attendance: AttendanceService, private leave: LeaveService, private expenses: ExpensesService) {}

  // ---------- Configuration ----------
  @Get('settings') @Perm('hr', 'view') settings(@CurrentActor() a: RequestActor) { return this.config.settings(a); }
  @Put('settings') @Perm('hr', 'edit') putSettings(@CurrentActor() a: RequestActor, @Body() b: unknown) { return this.config.putSettings(a, b); }
  @Get('holidays') @Perm('hr', 'view')
  holidays(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ from: date.optional(), to: date.optional() }))) q: { from?: string; to?: string }) { return this.config.holidays(a, q); }
  @Post('holidays') @Perm('hr', 'edit') addHoliday(@CurrentActor() a: RequestActor, @Body(new ZodPipe(holidayB)) b: z.infer<typeof holidayB>) { return this.config.addHoliday(a, b); }
  @Delete('holidays/:id') @Perm('hr', 'edit') @HttpCode(204) removeHoliday(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.config.removeHoliday(a, id); }
  @Get('office-locations') @Perm('hr', 'view') locations(@CurrentActor() a: RequestActor) { return this.config.locations(a); }
  @Post('office-locations') @Perm('hr', 'edit') addLocation(@CurrentActor() a: RequestActor, @Body(new ZodPipe(locationB)) b: z.infer<typeof locationB>) { return this.config.saveLocation(a, null, b); }
  @Patch('office-locations/:id') @Perm('hr', 'edit')
  patchLocation(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(locationPatchB)) b: z.infer<typeof locationPatchB>) { return this.config.saveLocation(a, id, b); }
  @Get('leave-types') @Perm('hr', 'view') leaveTypes(@CurrentActor() a: RequestActor) { return this.config.leaveTypes(a); }
  @Post('leave-types') @Perm('hr', 'edit') addLeaveType(@CurrentActor() a: RequestActor, @Body(new ZodPipe(leaveTypeB)) b: LeaveTypeIn) { return this.config.saveLeaveType(a, null, b); }
  @Patch('leave-types/:id') @Perm('hr', 'edit')
  patchLeaveType(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(leaveTypeB.omit({ key: true }).partial())) b: Partial<LeaveTypeIn>) { return this.config.saveLeaveType(a, id, b); }
  @Get('expense-categories') @Perm('hr', 'view') categories(@CurrentActor() a: RequestActor) { return this.config.categories(a); }
  @Put('expense-categories') @Perm('hr', 'edit') saveCategory(@CurrentActor() a: RequestActor, @Body(new ZodPipe(categoryB)) b: z.infer<typeof categoryB>) { return this.config.saveCategory(a, b); }
  @Put('capacity/:userId') @Perm('hr', 'edit') @HttpCode(204)
  capacity(@CurrentActor() a: RequestActor, @Param('userId', ParseUUIDPipe) userId: string, @Body(new ZodPipe(capacityB)) b: { weeklyMinutes: number }) { return this.config.setCapacity(a, userId, b.weeklyMinutes); }
  @Get('cost-rates') @Perm('settings', 'view') costRates(@CurrentActor() a: RequestActor, @Query(new ZodPipe(userQ)) q: { userId?: string }) { return this.config.costRates(a, q.userId); }
  @Post('cost-rates') @Perm('settings', 'edit') addCostRate(@CurrentActor() a: RequestActor, @Body(new ZodPipe(costB)) b: z.infer<typeof costB>) { return this.config.addCostRate(a, b); }
  @Delete('cost-rates/:id') @Perm('settings', 'edit') @HttpCode(204) removeCostRate(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.config.removeCostRate(a, id); }

  // ---------- Attendance ----------
  @Post('attendance/check-in') @Perm('hr', 'view')
  checkIn(@CurrentActor() a: RequestActor, @Body(new ZodPipe(checkInB)) b: z.infer<typeof checkInB>, @ClientIp() ip: string | null) { return this.attendance.checkIn(a, b, ip); }
  @Post('attendance/check-out') @Perm('hr', 'view') @HttpCode(200)
  checkOut(@CurrentActor() a: RequestActor, @Body(new ZodPipe(checkOutB)) b: z.infer<typeof checkOutB>) { return this.attendance.checkOut(a, b); }
  @Get('attendance') @Perm('hr', 'view') listAttendance(@CurrentActor() a: RequestActor, @Query(new ZodPipe(attQ)) q: z.infer<typeof attQ>) { return this.attendance.list(a, q); }
  @Post('attendance/:id/decide') @Perm('hr', 'view') @HttpCode(204)
  decideAttendance(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(decideB)) b: z.infer<typeof decideB>) { return this.attendance.decide(a, id, b); }
  @Get('attendance/report') @Perm('hr', 'view')
  attendanceReport(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ month }))) q: { month: string }) { return this.attendance.report(a, q.month); }
  @Post('attendance/regularisations') @Perm('hr', 'view')
  regularise(@CurrentActor() a: RequestActor, @Body(new ZodPipe(regB)) b: z.infer<typeof regB>) { return this.attendance.requestRegularisation(a, b); }
  @Get('attendance/regularisations') @Perm('hr', 'view')
  regularisations(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() }))) q: { status?: string }) { return this.attendance.regularisations(a, q); }
  @Post('attendance/regularisations/:id/decide') @Perm('hr', 'view') @HttpCode(204)
  decideRegularisation(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(decideB)) b: z.infer<typeof decideB>) { return this.attendance.decideRegularisation(a, id, b); }

  // ---------- Leave ----------
  @Get('leave/balances') @Perm('hr', 'view') balances(@CurrentActor() a: RequestActor, @Query(new ZodPipe(userQ)) q: { userId?: string }) { return this.leave.balances(a, q.userId); }
  @Get('leave/ledger') @Perm('hr', 'view') ledger(@CurrentActor() a: RequestActor, @Query(new ZodPipe(userQ)) q: { userId?: string }) { return this.leave.ledger(a, q.userId); }
  @Post('leave/ledger') @Perm('hr', 'approve') @HttpCode(204) adjust(@CurrentActor() a: RequestActor, @Body(new ZodPipe(adjustB)) b: z.infer<typeof adjustB>) { return this.leave.adjust(a, b); }
  @Post('leave/accrue') @Perm('hr', 'approve') @HttpCode(200) accrue(@CurrentActor() a: RequestActor, @Body(new ZodPipe(z.object({ month }).strict())) b: { month: string }) { return this.leave.accrue(a, b.month); }
  @Post('leave/comp-off/run') @Perm('hr', 'approve') @HttpCode(200) compOff(@CurrentActor() a: RequestActor, @Body(new ZodPipe(rangeB)) b: { from: string; to: string }) { return this.leave.runCompOff(a, b.from, b.to); }
  @Get('leave/requests') @Perm('hr', 'view') leaveRequests(@CurrentActor() a: RequestActor, @Query(new ZodPipe(leaveQ)) q: z.infer<typeof leaveQ>) { return this.leave.list(a, q); }
  @Post('leave/requests') @Perm('hr', 'view') applyLeave(@CurrentActor() a: RequestActor, @Body(new ZodPipe(applyB)) b: z.infer<typeof applyB>) { return this.leave.apply(a, b); }
  @Post('leave/requests/:id/decide') @Perm('hr', 'view') @HttpCode(200)
  decideLeave(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(leaveDecideB)) b: z.infer<typeof leaveDecideB>) { return this.leave.decide(a, id, b); }
  @Post('leave/requests/:id/cancel') @Perm('hr', 'view') @HttpCode(204) cancelLeave(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.leave.cancel(a, id); }

  // ---------- Expenses ----------
  @Get('expenses/claims') @Perm('hr', 'view')
  claims(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ userId: z.string().uuid().optional(), status: z.enum(CLAIM_STATUSES).optional() }))) q: { userId?: string; status?: string }) { return this.expenses.list(a, q); }
  @Post('expenses/claims') @Perm('hr', 'view') createClaim(@CurrentActor() a: RequestActor, @Body(new ZodPipe(claimB)) b: { title: string; lines: ExpenseLineIn[]; submit?: boolean }) { return this.expenses.create(a, b); }
  @Get('expenses/claims/:id') @Perm('hr', 'view') claim(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.expenses.get(a, id); }
  @Patch('expenses/claims/:id') @Perm('hr', 'view')
  updateClaim(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(claimPatchB)) b: { title?: string; lines?: ExpenseLineIn[] }) { return this.expenses.update(a, id, b); }
  @Post('expenses/claims/:id/submit') @Perm('hr', 'view') @HttpCode(204) submitClaim(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.expenses.submit(a, id); }
  @Post('expenses/claims/:id/decide') @Perm('hr', 'view') @HttpCode(200)
  decideClaim(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(claimDecideB)) b: z.infer<typeof claimDecideB>) { return this.expenses.decide(a, id, b); }
  @Post('expenses/claims/:id/pay') @Perm('hr', 'approve') @HttpCode(200)
  payClaim(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(payB)) b: { reference: string }) { return this.expenses.pay(a, id, b); }
  @Get('expenses/advances') @Perm('hr', 'view') advances(@CurrentActor() a: RequestActor, @Query(new ZodPipe(userQ)) q: { userId?: string }) { return this.expenses.advances(a, q); }
  @Post('expenses/advances') @Perm('hr', 'view') requestAdvance(@CurrentActor() a: RequestActor, @Body(new ZodPipe(advanceB)) b: z.infer<typeof advanceB>) { return this.expenses.requestAdvance(a, b); }
  @Post('expenses/advances/:id/decide') @Perm('hr', 'view') @HttpCode(200)
  decideAdvance(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(advDecideB)) b: z.infer<typeof advDecideB>) { return this.expenses.decideAdvance(a, id, b); }
  @Post('expenses/advances/:id/pay') @Perm('hr', 'approve') @HttpCode(204)
  payAdvance(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(payB)) b: { reference: string }) { return this.expenses.payAdvance(a, id, b); }
  @Get('expenses/reimbursable') @Perm('billing', 'view')
  reimbursable(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ clientId: z.string().uuid().optional() }))) q: { clientId?: string }) { return this.expenses.reimbursable(a, q); }
  @Post('expenses/lines/:id/link') @Perm('billing', 'edit') @HttpCode(204)
  link(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(linkB)) b: { invoiceLineId: string }) { return this.expenses.link(a, id, b.invoiceLineId); }
}
