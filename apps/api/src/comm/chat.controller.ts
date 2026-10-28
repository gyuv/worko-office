import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CHAT_CHANNEL_KINDS, workingHoursSchema } from '@worko/domain';
import { z } from 'zod';
import { CurrentActor, Perm, Public, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CalendarService } from './calendar.service.js';
import { ChatService } from './chat.service.js';

const uuids = (n: number) => z.array(z.string().uuid()).max(n);
const iso = z.string().datetime({ offset: true });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');
const channelB = z.object({ kind: z.enum(CHAT_CHANNEL_KINDS), name: z.string().trim().max(200).optional(), teamId: z.string().uuid().optional(), branchId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(), memberIds: uuids(200).optional() }).strict();
const postB = z.object({ body: z.string().max(10_000), mentions: uuids(50).optional(), attachmentDocIds: uuids(10).optional() }).strict();
const eventB = z.object({ kind: z.enum(['meeting', 'personal']).optional(), title: z.string().trim().min(1).max(300), description: z.string().max(5000).nullable().optional(),
  location: z.string().max(300).nullable().optional(), startsAt: iso, endsAt: iso, allDay: z.boolean().optional(), clientId: z.string().uuid().nullable().optional(),
  attendeeIds: uuids(50).optional(), busy: z.boolean().optional() }).strict();
const eventPatchB = eventB.partial().strict();
const pageB = z.object({ slug: z.string().regex(/^[a-z0-9-]{2,60}$/), title: z.string().trim().min(1).max(200), description: z.string().max(2000).nullable().optional(),
  hostUserIds: uuids(20).min(1).optional(), slotMinutes: z.number().int().min(10).max(480).optional(), bufferMinutes: z.number().int().min(0).max(240).optional(), workingHours: workingHoursSchema,
  horizonDays: z.number().int().min(1).max(180).optional(), minNoticeMinutes: z.number().int().min(0).max(20160).optional(), createTask: z.boolean().optional(), active: z.boolean().optional() }).strict();
const bookB = z.object({ startsAt: iso, name: z.string().trim().min(1).max(200), email: z.string().max(254).nullable().optional(), phone: z.string().max(20).nullable().optional(),
  purpose: z.string().trim().min(3).max(1000), consent: z.boolean().optional() }).strict();
const PUBLIC_LIMIT = { default: { limit: Number(process.env.BOOKING_RATE_LIMIT ?? 20), ttl: 60_000 } };

const toRow = (b: z.infer<typeof eventPatchB>) => Object.fromEntries(Object.entries({ kind: b.kind, title: b.title, description: b.description, location: b.location, starts_at: b.startsAt,
  ends_at: b.endsAt, all_day: b.allDay, client_id: b.clientId, attendee_ids: b.attendeeIds, busy: b.busy }).filter(([, v]) => v !== undefined));

/** Team chat — any staff user (no module grant needed); client-linked channels need communication on the client (D106). */
@Controller('chat')
export class ChatController {
  constructor(private chat: ChatService) {}
  @Get('channels') channels(@CurrentActor() a: RequestActor) { return this.chat.list(a); }
  @Post('channels') create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(channelB)) b: z.infer<typeof channelB>) { return this.chat.create(a, b); }
  @Post('channels/:id/members') @HttpCode(200)
  members(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ add: uuids(200).optional(), remove: uuids(200).optional() }).strict())) b: { add?: string[]; remove?: string[] }) { return this.chat.changeMembers(a, id, b); }
  @Get('channels/:id/messages')
  messages(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(z.object({ before: iso.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }))) q: { before?: string; limit: number }) { return this.chat.messages(a, id, q); }
  @Post('channels/:id/messages') post(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(postB)) b: z.infer<typeof postB>) { return this.chat.post(a, id, b); }
  @Post('channels/:id/read') @HttpCode(204)
  read(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ messageId: z.string().uuid() }).strict())) b: { messageId: string }) { return this.chat.markRead(a, id, b); }
  @Patch('messages/:id') edit(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ body: z.string().max(10_000) }).strict())) b: { body: string }) { return this.chat.edit(a, id, b); }
  @Delete('messages/:id') @HttpCode(204) remove(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.chat.remove(a, id); }
}

/** Calendar: own events for every staff user; booking pages need communication; public ICS/booking are token/slug based. */
@Controller('calendar')
export class CalendarController {
  constructor(private cal: CalendarService) {}
  @Get('events') events(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ from: date, to: date }))) q: { from: string; to: string }) { return this.cal.events(a, q); }
  @Post('events') createEvent(@CurrentActor() a: RequestActor, @Body(new ZodPipe(eventB)) b: z.infer<typeof eventB>) { return this.cal.createEvent(a, toRow(b)); }
  @Patch('events/:id') @HttpCode(204) updateEvent(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(eventPatchB)) b: z.infer<typeof eventPatchB>) { return this.cal.updateEvent(a, id, toRow(b)); }
  @Delete('events/:id') @HttpCode(204) deleteEvent(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.cal.updateEvent(a, id, {}, true); }
  @Get('feeds') feeds(@CurrentActor() a: RequestActor) { return this.cal.feeds(a); }
  @Post('feeds') createFeed(@CurrentActor() a: RequestActor, @Body(new ZodPipe(z.object({ maskClients: z.boolean().optional(), label: z.string().max(100).nullable().optional() }).strict())) b: { maskClients?: boolean; label?: string | null }) { return this.cal.createFeed(a, b); }
  @Delete('feeds/:id') @HttpCode(204) revokeFeed(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.cal.revokeFeed(a, id); }
  @Get('ics/:tenantId/:token') @Public() @Throttle(PUBLIC_LIMIT) @Header('Content-Type', 'text/calendar; charset=utf-8') @Header('Cache-Control', 'private, max-age=300')
  ics(@Param('tenantId') tenantId: string, @Param('token') token: string) { return this.cal.ics(tenantId, token); }
}

@Controller('booking')
export class BookingAdminController {
  constructor(private cal: CalendarService) {}
  @Get('pages') pages(@CurrentActor() a: RequestActor) { return this.cal.pages(a); }
  @Post('pages') @Perm('communication', 'create') create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(pageB)) b: z.infer<typeof pageB>) { return this.cal.savePage(a, null, b); }
  @Patch('pages/:id') @Perm('communication', 'edit') update(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(pageB.partial().strict())) b: Partial<z.infer<typeof pageB>>) { return this.cal.savePage(a, id, b); }
  @Get('appointments') @Perm('communication', 'view')
  appointments(@CurrentActor() a: RequestActor, @Query(new ZodPipe(z.object({ from: date.optional(), to: date.optional() }))) q: { from?: string; to?: string }) { return this.cal.appointments(a, q); }
}

/** Public booking pages: rate-limited, no PII in logs or audit (D108). */
@Controller('book')
export class BookingPublicController {
  constructor(private cal: CalendarService) {}
  @Get('manage/:token') @Public() @Throttle(PUBLIC_LIMIT) view(@Param('token') token: string) { return this.cal.manageView(token); }
  @Post('manage/:token/reschedule') @HttpCode(200) @Public() @Throttle(PUBLIC_LIMIT)
  reschedule(@Param('token') token: string, @Body(new ZodPipe(z.object({ startsAt: iso }).strict())) b: { startsAt: string }) { return this.cal.reschedule(token, b); }
  @Post('manage/:token/cancel') @HttpCode(200) @Public() @Throttle(PUBLIC_LIMIT) cancel(@Param('token') token: string) { return this.cal.cancelBooking(token); }
  @Get(':firm/:slug') @Public() @Throttle(PUBLIC_LIMIT)
  slots(@Param('firm') firm: string, @Param('slug') slug: string, @Query(new ZodPipe(z.object({ from: date.optional(), to: date.optional() }))) q: { from?: string; to?: string }) { return this.cal.publicSlots(firm, slug, q); }
  @Post(':firm/:slug') @Public() @Throttle(PUBLIC_LIMIT)
  book(@Param('firm') firm: string, @Param('slug') slug: string, @Body(new ZodPipe(bookB)) b: z.infer<typeof bookB>) { return this.cal.book(firm, slug, b); }
}
