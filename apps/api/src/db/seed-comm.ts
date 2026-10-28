import { addDaysIso, weekdayOf } from '@worko/domain';
import { createHash } from 'node:crypto';
import { insertNotifications } from '../notifications/insert.js';
import type { DbService } from './db.service.js';
import { uuidv7 } from './ids.js';

const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+05:30`);
/** Next weekday (Mon–Fri) strictly after `day`. */
const nextWeekday = (day: string, k = 1) => { let d = day; let n = 0; while (n < k) { d = addDaysIso(d, 1); if (weekdayOf(d) !== 0 && weekdayOf(d) !== 6) n++; } return d; };

/**
 * Phase 7 demo data, deterministic for `today`: templates (approved + draft), consents (one opted out), a client timeline
 * mixing email/WhatsApp/SMS/notes/calls, an unmatched inbound in the triage inbox, one completed broadcast and one draft
 * scheduled for next week, team chat with mentions, calendar meetings, and a booking page with two appointments.
 */
export async function seedComm(db: DbService, tenantId: string, today: string) {
  await db.tenantTx(tenantId, async (tx) => {
    const users = Object.fromEntries((await tx.query(`SELECT u.id, r.key FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id ORDER BY u.id`)).rows.map((r) => [r.key, r.id])) as Record<'partner' | 'manager' | 'senior' | 'article' | 'accountant', string>;
    const clients = (await tx.query(`SELECT c.id, c.name, ct.id AS contact_id, ct.name AS contact, ct.phone, ct.email FROM client c JOIN contact ct ON ct.client_id = c.id AND ct.is_primary
      WHERE c.status = 'active' ORDER BY c.file_no LIMIT 8`)).rows;
    const y = (d: string, hm = '11:00') => at(d, hm);
    const day = (k: number) => addDaysIso(today, k);

    // ---------- Templates ----------
    const tpl: Record<string, string> = {};
    for (const [name, channel, category, status, subject, body] of [
      ['gst_data_request', 'whatsapp', 'utility', 'approved', null, 'Dear {{contact.name}}, please share {{period}} sales and purchase data for GST filing by {{due_date}}. — {{firm.name}}'],
      ['itr_season', 'whatsapp', 'marketing', 'approved', null, 'Dear {{contact.name}}, ITR filing season is here. Reply to book a slot with {{firm.name}}.'],
      ['invoice_reminder', 'email', 'transactional', 'approved', 'Invoice {{invoice.number}} from {{firm.name}}', '<p>Dear {{contact.name}},</p><p>Invoice {{invoice.number}} for {{invoice.amount}} is due on {{invoice.due_date}}. View: {{link}}</p>'],
      ['appointment_confirmation', 'email', 'transactional', 'approved', 'Your appointment with {{firm.name}}', '<p>Dear {{contact.name}}, your appointment is confirmed for {{appointment.time}}. Manage: {{appointment.link}}</p>'],
      ['tds_due_sms', 'sms', 'utility', 'draft', null, 'TDS for {{period}} is due on {{due_date}}. - {{firm.name}}'],
    ] as const) {
      const id = uuidv7(); tpl[name] = id;
      await tx.query(`INSERT INTO comm_template (id, tenant_id, name, channel, category, subject, body, variables, status, provider_ref, submitted_at, decided_at, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12)`, [id, tenantId, name, channel, category, subject, body, [...new Set([...body.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((m) => m[1]))],
        status, channel === 'whatsapp' ? `mock-tpl-${name}` : null, status === 'approved' ? y(day(-30)) : null, users.partner]);
    }

    // ---------- Consents (first five opted in on WhatsApp, the sixth opted out by STOP) ----------
    const norm = (p: string) => `+91${p.replace(/\D/g, '').slice(-10)}`;
    for (const [i, c] of clients.slice(0, 6).entries()) {
      const out = i === 5;
      await tx.query(`INSERT INTO comm_consent (id, tenant_id, channel, address, client_id, contact_id, status, opted_in_at, opted_in_source, opted_out_at, opted_out_source, keyword)
        VALUES ($1,$2,'whatsapp',$3,$4,$5,$6,$7,'staff:form',$8,$9,$10)`, [uuidv7(), tenantId, norm(c.phone), c.id, c.contact_id, out ? 'opted_out' : 'opted_in', y(day(-40)),
        out ? y(day(-3), '18:20') : null, out ? 'keyword:whatsapp' : null, out ? 'STOP' : null]);
    }

    // ---------- Client timeline (first client) ----------
    const c0 = clients[0];
    const msg = async (m: Record<string, unknown>) => tx.query(`INSERT INTO comm_message (id, tenant_id, client_id, contact_id, direction, channel, address, subject, body, template_id, category, status,
        provider, provider_ref, cost_paise, call_minutes, triage, created_by, occurred_at, broadcast_id, device_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'seed')`, [uuidv7(), tenantId, m.client ?? null, m.contact ?? null, m.dir, m.ch, m.addr ?? null, m.subject ?? null,
      m.body, m.tpl ?? null, m.cat ?? null, m.status, m.provider ?? null, m.ref ?? null, m.cost ?? 0, m.minutes ?? null, m.triage ?? null, m.by ?? null, m.at, m.bc ?? null]);
    await msg({ client: c0.id, contact: c0.contact_id, dir: 'out', ch: 'whatsapp', addr: norm(c0.phone), body: `Dear ${c0.contact}, please share September sales and purchase data for GST filing by ${day(-5)}. — Sharma & Mehta, Chartered Accountants`,
      tpl: tpl.gst_data_request, cat: 'utility', status: 'read', provider: 'mock', ref: 'seed-w-1', cost: 13, by: users.manager, at: y(day(-9), '10:15') });
    await msg({ client: c0.id, contact: c0.contact_id, dir: 'in', ch: 'whatsapp', addr: norm(c0.phone), body: 'Sending by tomorrow. Purchase register attached in email.', status: 'received', provider: 'mock', ref: 'seed-w-in-1', at: y(day(-9), '12:40') });
    await msg({ client: c0.id, contact: c0.contact_id, dir: 'in', ch: 'email', addr: c0.email, subject: 'September purchase register', body: 'PFA the purchase register for September.', status: 'received', provider: 'mock:mail', ref: 'seed-m-1', at: y(day(-8), '09:05') });
    await msg({ client: c0.id, dir: 'out', ch: 'call', body: 'Called to confirm ITC mismatch of ₹4,200; client to check vendor invoice.', status: 'logged', minutes: 9, by: users.senior, at: y(day(-7), '16:30') });
    await msg({ client: c0.id, dir: 'internal', ch: 'note', body: 'GSTR-3B filed after ITC reconciliation. Next month: ask for e-way bills too.', status: 'logged', by: users.senior, at: y(day(-4), '17:10') });
    await msg({ client: c0.id, contact: c0.contact_id, dir: 'out', ch: 'sms', addr: norm(c0.phone), body: 'GSTR-3B for September filed. ARN shared on email. - Sharma & Mehta', cat: 'transactional', status: 'delivered', provider: 'mock', ref: 'seed-s-1', cost: 25, by: users.manager, at: y(day(-4), '17:30') });
    // Unmatched inbound (unknown number) waiting in the triage inbox.
    await msg({ dir: 'in', ch: 'whatsapp', addr: '+919900099000', body: 'Hello, I need help with my ITR. Got your number from Mr Kulkarni.', status: 'received', provider: 'mock', ref: 'seed-w-un-1', triage: 'unmatched', at: y(day(-1), '19:45') });

    // ---------- Broadcasts: one completed, one draft scheduled for next week ----------
    const done = uuidv7();
    await tx.query(`INSERT INTO broadcast (id, tenant_id, name, channel, template_id, category, filters, status, scheduled_at, completed_at, spent_paise, estimate, approved_by, approved_at, created_by)
      VALUES ($1,$2,'ITR season 2026','whatsapp',$3,'marketing',$4,'completed',$5,$6,$7,$8,$9,$5,$10)`, [done, tenantId, tpl.itr_season, JSON.stringify({ clientIds: clients.slice(0, 6).map((c) => c.id) }),
      y(day(-20), '10:00'), y(day(-20), '10:02'), 5 * 88, JSON.stringify({ audience: 6, eligible: 5, optedOut: 0, notOptedIn: 1, noContact: 0, overCap: 0, unitPaise: 88, costPaise: 440 }), users.partner, users.manager]);
    for (const [i, c] of clients.slice(0, 6).entries()) {
      const sent = i < 5;
      const mid = sent ? uuidv7() : null;
      if (sent) await tx.query(`INSERT INTO comm_message (id, tenant_id, client_id, contact_id, direction, channel, address, body, template_id, category, status, provider, provider_ref, cost_paise, broadcast_id, occurred_at, created_by, device_id)
        VALUES ($1,$2,$3,$4,'out','whatsapp',$5,$6,$7,'marketing','delivered','mock',$8,88,$9,$10,$11,'seed')`, [mid, tenantId, c.id, c.contact_id, norm(c.phone),
        `Dear ${c.contact}, ITR filing season is here. Reply to book a slot with Sharma & Mehta, Chartered Accountants.`, tpl.itr_season, `seed-bc-${i}`, done, y(day(-20), '10:01'), users.manager]);
      await tx.query(`INSERT INTO broadcast_recipient (id, tenant_id, broadcast_id, client_id, contact_id, address, status, message_id, cost_paise, attempts, error, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [uuidv7(), tenantId, done, c.id, c.contact_id, norm(c.phone), sent ? 'sent' : 'skipped_optout', mid, sent ? 88 : 0, sent ? 1 : 0, sent ? null : 'not_opted_in', sent ? y(day(-20), '10:01') : null]);
    }
    await tx.query(`INSERT INTO broadcast (id, tenant_id, name, channel, template_id, category, filters, variables, status, scheduled_at, created_by)
      VALUES ($1,$2,'GST data request — next month','whatsapp',$3,'utility',$4,$5,'draft',$6,$7)`, [uuidv7(), tenantId, tpl.gst_data_request, JSON.stringify({ tags: ['retainer'] }),
      JSON.stringify({ period: 'October', due_date: day(10) }), y(nextWeekday(today, 5), '10:30'), users.manager]);

    // ---------- Team chat ----------
    const team = (await tx.query(`SELECT id, name FROM team ORDER BY name LIMIT 1`)).rows[0];
    const teamMembers = (await tx.query(`SELECT user_id FROM team_member WHERE team_id = $1 UNION SELECT lead_user_id FROM team WHERE id = $1`, [team.id])).rows.map((r) => r.user_id as string);
    const channel = async (kind: string, name: string, members: string[], extra: Record<string, unknown> = {}) => {
      const id = uuidv7();
      await tx.query(`INSERT INTO chat_channel (id, tenant_id, kind, name, team_id, client_id, direct_key, created_by, created_at, device_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'seed')`,
        [id, tenantId, kind, name, extra.team ?? null, extra.client ?? null, extra.direct ?? null, members[0], y(day(-14), '09:00')]);
      for (const [i, u] of [...new Set(members)].entries()) await tx.query(`INSERT INTO chat_member (id, tenant_id, channel_id, user_id, role, joined_at, device_id) VALUES ($1,$2,$3,$4,$5,$6,'seed')`, [uuidv7(), tenantId, id, u, i === 0 ? 'owner' : 'member', y(day(-14), '09:00')]);
      return id;
    };
    const post = async (ch: string, author: string, body: string, when: Date, mentions: string[] = [], chName = '') => {
      const id = uuidv7();
      await tx.query(`INSERT INTO chat_message (id, tenant_id, channel_id, author_id, body, mentions, created_at, device_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'seed')`, [id, tenantId, ch, author, body, mentions, when]);
      if (mentions.length) await insertNotifications(tx, tenantId, { userIds: mentions, category: 'chat.mentioned', title: `Mention in ${chName}`, body: body.replace(/@\[([^\]]+)\]\([0-9a-f-]{36}\)/gi, '@$1').slice(0, 140), entityType: 'chat_message', entityId: id, dedupeKey: `mention:${id}`, fireAt: when });
      return id;
    };
    const gst = await channel('team', team.name, [users.manager, ...teamMembers], { team: team.id });
    await post(gst, users.manager, 'GSTR-1 for September: 6 clients still pending data. Please chase today.', y(day(-2), '10:05'));
    await post(gst, users.manager, `@[Priya Iyer](${users.senior}) can you take the ITC mismatch cases?`, y(day(-2), '10:07'), [users.senior], team.name);
    const last = await post(gst, users.senior, `On it. @[Karan Patel](${users.article}) please pull the 2B for the retainer clients.`, y(day(-2), '10:20'), [users.article], team.name);
    await tx.query('UPDATE chat_member SET last_read_message_id = $3, last_read_at = $4 WHERE channel_id = $1 AND user_id = $2', [gst, users.manager, last, y(day(-2), '10:30')]);
    const dm = await channel('direct', 'Direct', [users.partner, users.manager], { direct: [users.partner, users.manager].sort().join(':') });
    await post(dm, users.partner, 'Can we review the audit plan on Thursday?', y(day(-1), '18:00'));
    // Client channel on a client every member can see (the senior's own client).
    const sc = (await tx.query(`SELECT id, name FROM client WHERE $1::uuid = ANY(staff_ids) AND NOT sensitive ORDER BY file_no LIMIT 1`, [users.senior])).rows[0];
    const cc = await channel('client', sc.name, [users.partner, users.manager, users.senior], { client: sc.id });
    await post(cc, users.senior, 'Client confirmed the ITC mismatch is a vendor error; credit note expected next week.', y(day(-3), '15:00'));

    // ---------- Calendar ----------
    for (const [owner, title, d, s, e, client, attendees] of [
      [users.partner, 'Partners meeting', nextWeekday(today, 1), '09:30', '10:30', null, [users.manager]],
      [users.manager, `Review: ${c0.name}`, nextWeekday(today, 2), '15:00', '16:00', c0.id, [users.senior]],
      [users.senior, 'ICAI CPE seminar', nextWeekday(today, 3), '14:00', '17:00', null, []],
    ] as Array<[string, string, string, string, string, string | null, string[]]>) {
      await tx.query(`INSERT INTO calendar_event (id, tenant_id, owner_id, kind, title, starts_at, ends_at, client_id, attendee_ids, accepted_ids, created_by, device_id) VALUES ($1,$2,$3,'meeting',$4,$5,$6,$7,$8,$8,$3,'seed')`,
        [uuidv7(), tenantId, owner, title, at(d, s), at(d, e), client, attendees]);
    }

    // ---------- Booking page + two appointments ----------
    const page = uuidv7();
    const wh = Object.fromEntries(['1', '2', '3', '4', '5'].map((d) => [d, [['10:30', '13:00'], ['15:00', '18:00']]]));
    wh['6'] = [['10:30', '13:00']];
    await tx.query(`INSERT INTO booking_page (id, tenant_id, slug, title, description, host_user_ids, slot_minutes, buffer_minutes, working_hours, horizon_days, min_notice_minutes, create_task, created_by)
      VALUES ($1,$2,'consult','Tax consultation (30 min)','Income-tax, GST or company law questions.',$3,30,10,$4,21,240,true,$5)`, [page, tenantId, [users.partner, users.manager], JSON.stringify(wh), users.partner]);
    for (const [i, [d, hm, name, purpose, client]] of ([
      [nextWeekday(today, 1), '11:00', clients[1].contact, 'Capital gains on property sale', clients[1]],
      [nextWeekday(today, 2), '16:00', 'Neha Desai', 'New partnership firm registration', null],
    ] as Array<[string, string, string, string, Record<string, string> | null]>).entries()) {
      const id = uuidv7(); const ev = uuidv7(); const host = i === 0 ? users.partner : users.manager;
      const start = at(d, hm); const end = new Date(start.getTime() + 30 * 60_000);
      await tx.query(`INSERT INTO calendar_event (id, tenant_id, owner_id, kind, title, description, starts_at, ends_at, client_id, appointment_id, device_id) VALUES ($1,$2,$3,'appointment',$4,$5,$6,$7,$8,$9,'seed')`,
        [ev, tenantId, host, `Appointment: ${name}`, purpose, start, end, client?.id ?? null, id]);
      await tx.query(`INSERT INTO appointment (id, tenant_id, page_id, host_user_id, starts_at, ends_at, client_id, name, email, phone, purpose, event_id, manage_nonce, device_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'seed')`, [id, tenantId, page, host, start, end, client?.id ?? null, name, client?.email ?? 'neha.desai@example.in',
        client ? null : '+919812300456', purpose, ev, createHash('sha256').update(`seed-appt-${i}-${today}`).digest('base64url').slice(0, 16)]);
    }
  });
}

