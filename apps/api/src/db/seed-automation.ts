import { addDaysIso, agentTemplate, AI_FEATURES, aiSettingsSchema, ruleDefinitionSchema, type RuleDefinition } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import { KeyService, LocalKms } from '../crypto/key.service.js';
import type { DbService } from './db.service.js';
import { uuidv7 } from './ids.js';

const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+05:30`);

/**
 * Phase 10 demo data, deterministic for `today`. AI uses the MOCK provider with the firm's opt-in on (labelled "[Mock AI]");
 * outside the demo AI stays off by default. Rules: the Document Collection Agent for GST services with run history (reminders
 * sent, then stopped when the client uploaded), an Overdue Task Nudger, and a rule paused after repeated failures. Three AI
 * suggestions await approval (draft reply, timeline summary, upload classification) and the usage meter has entries.
 */
export async function seedAutomationAi(db: DbService, tenantId: string, today: string) {
  const keys = new KeyService(new LocalKms()); const audit = new AuditService();
  const day = (k: number) => addDaysIso(today, k);
  const month = today.slice(0, 7);
  await db.tenantTx(tenantId, async (tx) => {
    const users = Object.fromEntries((await tx.query(`SELECT u.id, r.key FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id ORDER BY u.id`)).rows.map((r) => [r.key, r.id])) as Record<string, string>;
    const partner = users.partner!;
    await tx.query(`INSERT INTO ai_settings (tenant_id, settings, updated_by) VALUES ($1,$2,$3)`,
      [tenantId, JSON.stringify(aiSettingsSchema.parse({ enabled: true, features: Object.fromEntries(AI_FEATURES.map((f) => [f, f !== 'ask'])), monthlyCapPaise: 100_000 })), partner]);

    const rule = async (name: string, def: RuleDefinition, o: { agent?: string; params?: unknown; status?: 'active' | 'paused'; failures?: number; enabled?: boolean } = {}) => {
      const id = uuidv7();
      const trigger = def.trigger.kind === 'event' ? def.trigger.event : 'schedule';
      await tx.query(`INSERT INTO automation_rule (id, tenant_id, name, description, owner_id, scope, enabled, status, paused_reason, paused_at, definition, trigger_kind, trigger_event, listen_events,
          agent_key, agent_params, consecutive_failures, created_by, created_at, device_id) VALUES ($1,$2,$3,$4,$5,'firm',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$5,$17,'seed')`,
      [id, tenantId, name, o.agent ? agentTemplate(o.agent)!.description : null, partner, o.enabled ?? true, o.status ?? 'active', o.status === 'paused' ? 'repeated_failures' : null,
        o.status === 'paused' ? at(day(-1), '09:20') : null, JSON.stringify(def), def.trigger.kind, trigger, [...new Set([trigger, ...(def.ladder?.stopOn ?? [])])], o.agent ?? null,
        o.params ? JSON.stringify(o.params) : null, o.failures ?? 0, at(day(-10), '10:00')]);
      await tx.query(`INSERT INTO automation_rule_version (id, tenant_id, rule_id, rule_version, name, definition, changed_by, changed_at, note) VALUES ($1,$2,$3,1,$4,$5,$6,$7,'seed')`,
        [uuidv7(), tenantId, id, name, JSON.stringify(def), partner, at(day(-10), '10:00')]);
      await audit.record(tx, tenantId, { actorId: partner, deviceId: 'seed', action: 'automation.rule_created', entity: 'automation_rule', entityId: id, diff: { name, agent: o.agent ?? null } });
      return id;
    };
    const event = async (type: string, entityType: string, entityId: string, clientId: string | null, payload: Record<string, unknown>, when: Date) => {
      const id = uuidv7();
      await tx.query(`INSERT INTO automation_event (id, tenant_id, type, entity_type, entity_id, client_id, payload, occurred_at, processed_at, device_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,'seed')`,
        [id, tenantId, type, entityType, entityId, clientId, JSON.stringify(payload), when]);
      return id;
    };
    const run = async (ruleId: string, eventId: string, step: string, status: string, when: Date, actions: Array<{ type: string; status: string; code?: string | null; result?: unknown; cost?: number; error?: string }>, extra: { subject?: string; skip?: string; error?: string } = {}) => {
      const id = uuidv7();
      await tx.query(`INSERT INTO automation_run (id, tenant_id, rule_id, rule_version, event_id, subject_key, step, status, skip_reason, idempotency_key, actions_total, actions_done, cost_paise, error, started_at, finished_at, device_id)
        VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,'seed')`, [id, tenantId, ruleId, eventId, extra.subject ?? null, step, status, extra.skip ?? null, `${ruleId}:${eventId}`, actions.length,
        actions.filter((a) => a.status === 'done' || a.status === 'queued').length, actions.reduce((n, a) => n + (a.cost ?? 0), 0), extra.error ?? null, when]);
      for (const [i, a] of actions.entries()) {
        await tx.query(`INSERT INTO automation_run_action (id, tenant_id, run_id, idx, type, status, code, result, cost_paise, error, finished_at, device_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'seed')`,
          [uuidv7(), tenantId, id, i, a.type, a.status, a.code ?? null, JSON.stringify(a.result ?? {}), a.cost ?? 0, a.error ?? null, when]);
      }
      return id;
    };

    // ---------- Document Collection Agent (GST) ----------
    const dcParams = agentTemplate('document_collection')!.params.parse({ serviceKeys: ['GSTR1', 'GSTR3B'], channel: 'email' });
    const dc = await rule('Document Collection Agent — GST', agentTemplate('document_collection')!.build(dcParams), { agent: 'document_collection', params: dcParams });
    const gst = (await tx.query(`SELECT t.id, t.title, t.client_id, t.statutory_due, c.name, ct.email FROM task t JOIN service_type st ON st.id = t.service_type_id JOIN client c ON c.id = t.client_id
      JOIN contact ct ON ct.client_id = c.id AND ct.is_primary WHERE st.key IN ('GSTR1','GSTR3B') AND t.outcome IS NULL AND t.status IN ('open','pending_client') AND ct.email IS NOT NULL
      ORDER BY c.file_no, t.statutory_due LIMIT 2`)).rows as Array<{ id: string; title: string; client_id: string; statutory_due: Date; name: string; email: string }>;
    const remind = async (tk: (typeof gst)[number], when: Date, n: number) => {
      const msg = uuidv7();
      await tx.query(`INSERT INTO comm_message (id, tenant_id, client_id, direction, channel, address, subject, body, category, status, cost_paise, provider, created_by, occurred_at, send_at, device_id)
        VALUES ($1,$2,$3,'out','email',$4,$5,$6,'transactional','sent',0,'mock',$7,$8,$8,$9)`, [msg, tenantId, tk.client_id, tk.email.toLowerCase(), `Documents needed: ${tk.title}`,
        `Dear ${tk.name},\n\nPlease share the documents for ${tk.title} on the client portal or by reply. (Reminder ${n})\n\nThank you.`, partner, when, `automation:${dc}`]);
      return msg;
    };
    for (const [k, tk] of gst.entries()) {
      const due = tk.statutory_due instanceof Date ? `${tk.statutory_due.getFullYear()}-${String(tk.statutory_due.getMonth() + 1).padStart(2, '0')}-${String(tk.statutory_due.getDate()).padStart(2, '0')}` : String(tk.statutory_due);
      const subject = `task:${tk.id}:${due}`;
      const e1 = await event('compliance.due_soon', 'task', tk.id, tk.client_id, { due, subjectKey: subject }, at(day(-6), '09:16'));
      await run(dc, e1, 'first', 'succeeded', at(day(-6), '09:16'), [
        { type: 'set_task_status', status: 'done', result: { taskId: tk.id, status: 'pending_client' } },
        { type: 'send_message', status: 'done', result: { messageId: await remind(tk, at(day(-6), '09:16'), 1), status: 'sent' } }], { subject });
      await tx.query(`UPDATE task SET status = 'pending_client', pending_issue = $2 WHERE id = $1`, [tk.id, `Please upload the documents for ${tk.title}.`]);
      const e2 = await event('compliance.due_soon', 'task', tk.id, tk.client_id, { due, subjectKey: subject }, at(day(-3), '09:16'));
      await run(dc, e2, 'repeat', 'succeeded', at(day(-3), '09:16'), [{ type: 'send_message', status: 'done', result: { messageId: await remind(tk, at(day(-3), '09:16'), 2), status: 'sent' } }], { subject });
      // The first client uploaded on the portal → the ladder stopped for them; the second is still being reminded.
      const stopped = k === 0;
      if (stopped) {
        const doc = (await tx.query(`SELECT id FROM document WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1`, [tk.client_id])).rows[0]?.id ?? tk.id;
        const e3 = await event('document.uploaded', 'document', doc, tk.client_id, { source: 'portal' }, at(day(-2), '18:40'));
        await run(dc, e3, 'stop', 'succeeded', at(day(-2), '18:40'), [], { skip: 'stopped 1 on document.uploaded' });
      }
      await tx.query(`INSERT INTO automation_subject (id, tenant_id, rule_id, subject_key, entity_type, entity_id, client_id, steps, last_step_day, stopped_at, stop_reason, device_id)
        VALUES ($1,$2,$3,$4,'task',$5,$6,2,$7,$8,$9,'seed')`, [uuidv7(), tenantId, dc, subject, tk.id, tk.client_id, day(-3), stopped ? at(day(-2), '18:40') : null, stopped ? 'document.uploaded' : null]);
    }

    // ---------- Overdue Task Nudger ----------
    const onParams = agentTemplate('overdue_nudger')!.params.parse({});
    const on = await rule('Overdue Task Nudger', agentTemplate('overdue_nudger')!.build(onParams), { agent: 'overdue_nudger', params: onParams });
    const late = (await tx.query(`SELECT id, client_id, statutory_due, assignee_id, title FROM task WHERE outcome IS NULL AND status NOT IN ('done','cancelled') AND statutory_due < $1 AND assignee_id IS NOT NULL
      ORDER BY statutory_due, id LIMIT 3`, [today])).rows;
    for (const tk of late) {
      const e = await event('task.overdue', 'task', tk.id, tk.client_id, { due: String(tk.statutory_due), subjectKey: `task:${tk.id}` }, at(day(-1), '09:16'));
      const nid = uuidv7();
      await tx.query(`INSERT INTO notification (id, tenant_id, user_id, category, priority, title, body, entity_type, entity_id, fire_at, dedupe_key, device_id)
        VALUES ($1,$2,$3,'automation.alert','high',$4,'From automation “Overdue Task Nudger”','task',$5,$6,$7,'server')`, [nid, tenantId, tk.assignee_id, `Overdue: ${tk.title}`.slice(0, 200), tk.id, at(day(-1), '09:16'), `auto-seed:${tk.id}`]);
      await run(on, e, 'first', 'succeeded', at(day(-1), '09:16'), [{ type: 'notify', status: 'done', result: { notificationIds: [nid], recipients: 1 } }], { subject: `task:${tk.id}` });
    }

    // ---------- A rule paused after repeated failures ----------
    const brokenDef = ruleDefinitionSchema.parse({ trigger: { kind: 'event', event: 'invoice.issued' }, actions: [{ type: 'create_task', title: 'Follow up payment: {{client.name}}', assignee: { userId: '00000000-0000-4000-8000-00000000dead' }, dueInDays: 7 }],
      limits: { pauseAfterFailures: 3 } });
    const broken = await rule('Payment follow-up task (paused)', brokenDef, { status: 'paused', failures: 3 });
    const invs = (await tx.query(`SELECT id, client_id FROM invoice WHERE status <> 'draft' AND kind = 'invoice' ORDER BY number LIMIT 3`)).rows;
    for (const [i, inv] of invs.entries()) {
      const e = await event('invoice.issued', 'invoice', inv.id, inv.client_id, {}, at(day(-3 + i), '11:00'));
      await run(broken, e, 'first', 'failed', at(day(-3 + i), '11:00'), [{ type: 'create_task', status: 'failed', code: 'http_400', error: 'Unknown user in assignee_id (user was removed)' }], { error: 'http_400' });
    }
    await tx.query(`INSERT INTO notification (id, tenant_id, user_id, category, priority, title, body, entity_type, entity_id, fire_at, dedupe_key, device_id)
      VALUES ($1,$2,$3,'automation.failed','high','Automation paused: Payment follow-up task (paused)','Paused after 3 failing runs (last: http_400). Fix it and resume.','automation_rule',$4,$5,$6,'server')`,
    [uuidv7(), tenantId, partner, broken, at(day(-1), '11:00'), `auto-paused:${broken}`]);

    // ---------- Pending AI suggestions (mock provider) ----------
    const client = (await tx.query(`SELECT c.id, c.name FROM client c WHERE c.file_no = 'F-101'`)).rows[0] ?? (await tx.query(`SELECT id, name FROM client ORDER BY file_no LIMIT 1`)).rows[0];
    const inbound = (await tx.query(`SELECT id FROM comm_message WHERE client_id = $1 AND direction = 'in' ORDER BY occurred_at DESC LIMIT 1`, [client.id])).rows[0]?.id
      ?? (await tx.query(`SELECT id FROM comm_message WHERE client_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [client.id])).rows[0]?.id ?? client.id;
    const upload = (await tx.query(`SELECT id, name, client_id FROM document WHERE source = 'portal' ORDER BY created_at LIMIT 1`)).rows[0];
    const sug = async (kind: string, feature: string, clientId: string, entityType: string, entityId: string, payload: Record<string, unknown>, sources: unknown[], tokens: [number, number], hm: string) => {
      const id = uuidv7();
      const enc = (v: unknown, f: string) => keys.encrypt(tx, tenantId, typeof v === 'string' ? v : JSON.stringify(v), `suggestion:${id}:${f}`);
      await tx.query(`INSERT INTO suggestion (id, tenant_id, kind, feature, status, client_id, entity_type, entity_id, requested_by, provider, model, payload_enc, prompt_enc, sources, meta, purge_after, created_at, device_id)
        VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,'mock','mock-1',$9,$10,$11,$12,$13,$14,'seed')`, [id, tenantId, kind, feature, clientId, entityType, entityId, partner,
        await enc(payload, 'payload'), await enc('[mock prompt — redacted demo]', 'prompt'), JSON.stringify(sources), JSON.stringify({ inputTokens: tokens[0], outputTokens: tokens[1], costPaise: 0, demo: 'mock' }),
        at(addDaysIso(today, 90), '00:00'), at(today, hm)]);
      await tx.query(`INSERT INTO ai_usage (id, tenant_id, feature, user_id, suggestion_id, provider, model, input_tokens, output_tokens, cost_paise, month, occurred_at, device_id) VALUES ($1,$2,$3,$4,$5,'mock','mock-1',$6,$7,0,$8,$9,'seed')`,
        [uuidv7(), tenantId, feature, partner, id, tokens[0], tokens[1], month, at(today, hm)]);
      await audit.record(tx, tenantId, { actorId: partner, deviceId: 'seed', action: 'suggestion.created', entity: 'suggestion', entityId: id, diff: { kind, feature, provider: 'mock' } });
    };
    await sug('draft_reply', 'draft_reply', client.id, 'comm_message', inbound, { subject: 'Re: your message', channel: 'email',
      body: `[Mock AI] Dear ${client.name},\n\nThank you for writing to us. We have noted your message and will get back to you by tomorrow.\n\nRegards` },
    [{ type: 'client', id: client.id, label: client.name }, { type: 'comm_message', id: inbound, label: 'latest message' }], [412, 61], '09:30');
    await sug('summary', 'summarise', client.id, 'client', client.id, { summary: `[Mock AI] ${client.name}: GST returns on track; documents for the current month were requested twice and received on the portal; one invoice is open.`,
      points: ['Documents requested and received on the portal', 'One open invoice', 'No open notices'] }, [{ type: 'client', id: client.id, label: client.name }], [903, 88], '09:35');
    if (upload) {
      await sug('classification', 'classify_upload', upload.client_id, 'document', upload.id, { category: 'GST', fy: '2026-27', confidence: 0.8, current: { category: 'Portal uploads', fy: null } },
        [{ type: 'document', id: upload.id, label: upload.name }], [188, 13], '09:40');
    }
    // Extra usage history (earlier this month), e.g. notice extraction through the AI layer.
    for (const [i, f] of (['notice_extraction', 'draft_reply', 'summarise'] as const).entries()) {
      await tx.query(`INSERT INTO ai_usage (id, tenant_id, feature, user_id, provider, model, input_tokens, output_tokens, cost_paise, month, occurred_at, device_id) VALUES ($1,$2,$3,$4,'mock','mock-1',$5,$6,0,$7,$8,'seed')`,
        [uuidv7(), tenantId, f, users.manager ?? partner, 600 + i * 100, 120 + i * 10, month, at(day(-5 + i), '15:00')]);
    }
  });
}
