import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { prefsSchema, type Prefs } from '@worko/notify';
import { z } from 'zod';
import { CurrentActor, Public, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { NotificationsService } from './notifications.service.js';

const listQ = z.object({ unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional(), limit: z.coerce.number().int().min(1).max(200).default(50), before: z.string().datetime({ offset: true }).optional() });
const snoozeB = z.object({ until: z.coerce.date().refine((d) => d.getTime() > Date.now() && d.getTime() < Date.now() + 30 * 86400_000, 'Within the next 30 days') });
const subB = z.object({ kind: z.enum(['fcm', 'webpush']), endpoint: z.string().min(10).max(2000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }).optional() })
  .refine((s) => s.kind !== 'webpush' || /^https:\/\//.test(s.endpoint), 'Web Push endpoint must be https');

/** Users only ever see and act on their own notifications (enforced in the service), so no @Perm needed. */
@Controller()
export class NotificationsController {
  constructor(private n: NotificationsService) {}

  @Get('notifications')
  list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listQ)) q: z.infer<typeof listQ>) { return this.n.list(a, q); }

  @Get('notifications/unread-count')
  unread(@CurrentActor() a: RequestActor) { return this.n.unreadCount(a); }

  @Post('notifications/read-all') @HttpCode(204)
  async readAll(@CurrentActor() a: RequestActor) { await this.n.readAll(a); }

  @Post('notifications/:id/read') @HttpCode(204)
  async read(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.n.act(a, id, 'read'); }

  @Post('notifications/:id/ack') @HttpCode(204)
  async ack(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.n.act(a, id, 'ack'); }

  @Post('notifications/:id/snooze') @HttpCode(204)
  async snooze(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(snoozeB)) b: z.infer<typeof snoozeB>) {
    await this.n.act(a, id, 'snooze', b.until);
  }

  /** Lets a user check their devices receive alerts — critical, so quiet hours don't make it look broken. */
  @Post('notifications/test') @HttpCode(201)
  async test(@CurrentActor() a: RequestActor) {
    const [id] = await this.n.send(a.tenantId, { userIds: [a.userId], category: 'system.test', priority: 'critical', title: 'Test notification', body: 'Notifications are working on this account.' });
    return { id };
  }

  @Get('notifications/prefs')
  prefs(@CurrentActor() a: RequestActor) { return this.n.getPrefs(a); }

  @Put('notifications/prefs') @HttpCode(204)
  async putPrefs(@CurrentActor() a: RequestActor, @Body(new ZodPipe(prefsSchema)) b: Prefs) { await this.n.putPrefs(a, b); }

  @Post('push/subscriptions') @HttpCode(201)
  subscribe(@CurrentActor() a: RequestActor, @Body(new ZodPipe(subB)) b: z.infer<typeof subB>) { return this.n.subscribe(a, b); }

  @Delete('push/subscriptions/:id') @HttpCode(204)
  async unsubscribe(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.n.unsubscribe(a, id); }

  @Public() @Get('push/vapid-public-key')
  vapid() { return { key: process.env.VAPID_PUBLIC_KEY ?? null }; }
}
