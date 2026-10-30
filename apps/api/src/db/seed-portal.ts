import { addDaysIso, DEFAULT_ENGAGEMENT_LETTER, defaultPortalGrants, PORTAL_INBOX_CATEGORY, portalGrantsSchema, proposalTotals, type ProposalLine } from '@worko/domain';
import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { AuditService } from '../audit/audit.service.js';
import { InvoicesService } from '../billing/invoices.service.js';
import { Clock } from '../common/clock.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { storageFactory } from '../storage/storage.js';
import { SYNC_TABLES } from '../sync/registry.js';
import { SyncService } from '../sync/sync.service.js';
import { systemActor } from '../tasks/system-actor.js';
import type { DbService, Tx } from './db.service.js';
import { uuidv7 } from './ids.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+05:30`);

/** Portal demo logins (codes are sent through the mock channel; see seed output). */
export const PORTAL_DEMO = {
  group: { name: 'Vikram Shah', email: 'director@sahyadri.example', phone: '+919870000101', clients: ['F-106', 'F-107'] },
  restricted: { name: 'Swati Kale', email: 'accounts@kulkarni.example', phone: '+919870000102', clients: ['F-101'] },
} as const;

async function pdfOf(title: string, body: string): Promise<Buffer> {
  const d = new PDFDocument({ size: 'A4', margin: 56, info: { CreationDate: new Date('2026-01-01T00:00:00Z') } }); const parts: Buffer[] = [];
  d.on('data', (c: Buffer) => parts.push(c)); const done = new Promise((r) => d.on('end', r));
  d.fontSize(16).text(title, { align: 'center' }).moveDown().fontSize(10.5).text(body); d.end(); await done;
  return Buffer.concat(parts);
}

/**
 * Phase 9 demo data, deterministic for `today`: white-label portal settings; portal on for three clients; a director with one
 * login for two Sahyadri group companies and a restricted accounts contact (ITR documents + requests only); client-visible
 * documents, a client upload, a PBC item answered from the portal, a portal thread, an issued invoice with a live mock payment link,
 * a pending e-sign (from Phase 8); leads across every stage with activities; proposals draft / sent v2 after an edit / accepted →
 * converted client with subscriptions, client rates and an engagement letter / declined.
 */
export async function seedPortalLeads(db: DbService, tenantId: string, today: string) {
  const storage = storageFactory();
  const day = (k: number) => addDaysIso(today, k);
  const ids = await db.tenantTx(tenantId, async (tx) => {
    const users = Object.fromEntries((await tx.query(`SELECT u.id, r.key FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id ORDER BY u.id`)).rows.map((r) => [r.key, r.id])) as Record<string, string>;
    const byFile = async (f: string) => (await tx.query(`SELECT c.id, c.name, ct.id AS contact_id FROM client c JOIN contact ct ON ct.client_id = c.id AND ct.is_primary WHERE c.file_no = $1`, [f])).rows[0] as { id: string; name: string; contact_id: string };
    const doc = async (clientId: string, name: string, category: string, bytes: Buffer, o: { fy?: string | null; visible?: boolean; portalUser?: string | null } = {}) => {
      const id = uuidv7(); const key = `t/${tenantId}/d/${id}/v1`;
      await storage.put(key, bytes, 'application/pdf');
      await tx.query(`INSERT INTO document (id, tenant_id, client_id, fy, category, name, mime, size, sha256, storage_key, uploaded_by, client_visible, source, portal_user_id, tags, device_id)
        VALUES ($1,$2,$3,$4,$5,$6,'application/pdf',$7,$8,$9,$10,$11,$12,$13,$14,'seed')`, [id, tenantId, clientId, o.fy ?? null, category, name, bytes.length, sha(bytes), key,
        o.portalUser ? null : users.senior, o.visible ?? false, o.portalUser ? 'portal' : 'staff', o.portalUser ?? null, o.portalUser ? ['portal'] : []]);
      await tx.query(`INSERT INTO document_version (id, tenant_id, document_id, version, storage_key, size, sha256, mime, uploaded_by) VALUES ($1,$2,$3,1,$4,$5,$6,'application/pdf',$7)`,
        [uuidv7(), tenantId, id, key, bytes.length, sha(bytes), o.portalUser ? null : users.senior]);
      return id;
    };

    // ---------- White-label + portal users ----------
    await tx.query(`INSERT INTO portal_settings (tenant_id, settings, updated_by) VALUES ($1,$2,$3)`, [tenantId, JSON.stringify({
      displayName: 'Sharma & Mehta Client Desk', logoDocumentId: null, accent: 'teal', customDomain: 'clients.sharmamehta.example.in', supportEmail: 'help@sharmamehta.example.in',
      supportPhone: '+912012345678', welcomeText: 'Upload documents, answer our requests and pay invoices — all in one place.', defaultGrants: defaultPortalGrants(),
    }), users.partner]);
    await tx.query(`INSERT INTO crm_settings (tenant_id, settings, updated_by) VALUES ($1,$2,$3)`, [tenantId, JSON.stringify({ proposalValidityDays: 30, engagementLetterTemplate: DEFAULT_ENGAGEMENT_LETTER,
      defaultTerms: 'Fees are payable within 15 days of invoice. Out-of-pocket expenses at actuals. Either party may end the engagement with 30 days\' notice.' }), users.partner]);
    const g1 = await byFile('F-106'); const g2 = await byFile('F-107'); const r1 = await byFile('F-101');
    const person = async (p: { name: string; email: string; phone: string }, contacts: string[]) => {
      const id = uuidv7();
      await tx.query(`INSERT INTO portal_user (id, tenant_id, name, email, phone, status, invited_by, last_login_at) VALUES ($1,$2,$3,$4,$5,'active',$6,$7)`, [id, tenantId, p.name, p.email, p.phone, users.partner, at(day(-1), '19:30')]);
      // The contact record is the person the firm already knows; their sign-in identity is the same email/mobile.
      for (const c of contacts) await tx.query('UPDATE contact SET name = $2, email = $3, phone = $4 WHERE id = $1', [c, p.name, p.email, p.phone]);
      return id;
    };
    const u1 = await person(PORTAL_DEMO.group, [g1.contact_id, g2.contact_id]);
    const u2 = await person(PORTAL_DEMO.restricted, [r1.contact_id]);
    const grant = async (u: string, c: { id: string; contact_id: string }, g: unknown) => tx.query(`INSERT INTO portal_access (id, tenant_id, portal_user_id, client_id, contact_id, grants, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv7(), tenantId, u, c.id, c.contact_id, JSON.stringify(portalGrantsSchema.parse(g)), users.partner]);
    await grant(u1, g1, {}); await grant(u1, g2, { notices: true });
    await grant(u2, r1, { documents: { categories: ['ITR', 'Engagement letters'] }, invoices: false, payments: false, esign: false });
    await tx.query(`UPDATE client SET portal_enabled = true WHERE id = ANY($1::uuid[])`, [[g1.id, g2.id, r1.id]]);
    for (const [c, u] of [[g1.id, u1], [g2.id, u1], [r1.id, u2]] as const) {
      await tx.query(`INSERT INTO comm_consent (id, tenant_id, channel, address, client_id, status, opted_in_at, opted_in_source) VALUES ($1,$2,'email',$3,$4,'opted_in',$5,'portal')
        ON CONFLICT (tenant_id, channel, address) DO NOTHING`, [uuidv7(), tenantId, u === u1 ? PORTAL_DEMO.group.email : PORTAL_DEMO.restricted.email, c, at(day(-1), '19:31')]);
    }

    // ---------- Documents ----------
    await tx.query(`UPDATE document SET client_visible = true WHERE client_id = ANY($1::uuid[]) AND category IN ('ITR','GST','Engagement letters','E-sign certificates')`, [[g1.id, g2.id, r1.id]]);
    await doc(g1.id, 'ITR-V AY 2026-27.pdf', 'ITR', await pdfOf('ITR-V acknowledgement', 'Assessment year 2026-27 (demo)'), { fy: '2025-26', visible: true });
    await doc(r1.id, 'Computation of income AY 2026-27.pdf', 'ITR', await pdfOf('Computation of income', 'Demo computation'), { fy: '2025-26', visible: true });
    await doc(r1.id, 'Internal review notes.pdf', 'ITR', await pdfOf('Review notes', 'Staff only'), { fy: '2025-26', visible: false });
    const upl = await doc(g1.id, 'Bank statement Sep 2026.pdf', PORTAL_INBOX_CATEGORY, await pdfOf('Bank statement', 'Uploaded by the client (demo)'), { fy: '2026-27', portalUser: u1 });
    await tx.query(`INSERT INTO notification (id, tenant_id, user_id, category, priority, title, body, entity_type, entity_id, fire_at, device_id) VALUES ($1,$2,$3,'client.uploaded','normal',$4,'Received through the client portal','document',$5,$6,'server')`,
      [uuidv7(), tenantId, users.senior, `${g1.name} uploaded a document`, upl, at(day(-1), '19:40')]);

    // ---------- PBC answered via the portal (engagement from Phase 8 on F-101) ----------
    const eng = (await tx.query(`SELECT id FROM audit_engagement WHERE client_id = $1 ORDER BY created_at LIMIT 1`, [r1.id])).rows[0]?.id as string | undefined;
    if (eng) {
      const d = await doc(r1.id, 'Stock statement 31-03-2026.pdf', PORTAL_INBOX_CATEGORY, await pdfOf('Stock statement', 'As on 31 March 2026 (demo)'), { fy: '2025-26', portalUser: u2 });
      const pbc = uuidv7();
      await tx.query(`INSERT INTO pbc_item (id, tenant_id, engagement_id, client_id, title, due_date, status, document_ids, received_at, client_response, responded_at, created_by)
        VALUES ($1,$2,$3,$4,'Stock statement as on 31 March',$5,'received',$6,$7,$8,$7,$9)`, [pbc, tenantId, eng, r1.id, day(-1), [d], at(day(-1), '20:05'), 'Signed stock statement attached.', users.senior]);
      await tx.query(`INSERT INTO comm_message (id, tenant_id, client_id, contact_id, direction, channel, subject, body, status, meta, portal_user_id, document_ids, occurred_at, device_id)
        VALUES ($1,$2,$3,$4,'in','portal','Re: Stock statement as on 31 March','Signed stock statement attached.','received',$5,$6,$7,$8,'portal')`,
      [uuidv7(), tenantId, r1.id, r1.contact_id, JSON.stringify({ pbcItemId: pbc }), u2, [d], at(day(-1), '20:05')]);
    }
    // A short portal thread.
    await tx.query(`INSERT INTO comm_message (id, tenant_id, client_id, contact_id, direction, channel, body, status, portal_user_id, occurred_at, device_id) VALUES ($1,$2,$3,$4,'in','portal',$5,'received',$6,$7,'portal')`,
      [uuidv7(), tenantId, g1.id, g1.contact_id, 'Could you confirm the GSTR-3B for September is filed?', u1, at(day(-1), '18:10')]);
    await tx.query(`INSERT INTO comm_message (id, tenant_id, client_id, direction, channel, body, status, created_by, occurred_at, device_id) VALUES ($1,$2,$3,'out','portal',$4,'sent',$5,$6,'seed')`,
      [uuidv7(), tenantId, g1.id, 'Yes — filed on the 18th. The acknowledgement is in your documents.', users.senior, at(day(-1), '18:45')]);

    // ---------- Leads & proposals ----------
    const st = Object.fromEntries((await tx.query(`SELECT key, id, name FROM service_type WHERE deleted_at IS NULL`)).rows.map((r) => [r.key, r])) as Record<string, { id: string; name: string }>;
    const rate = async (k: string) => Number((await tx.query(`SELECT amount_paise FROM billing_rate WHERE service_type_id = $1 AND client_id IS NULL ORDER BY effective_from DESC LIMIT 1`, [st[k]!.id])).rows[0]?.amount_paise ?? 200_000);
    const entity = (await tx.query(`SELECT id FROM firm_entity ORDER BY id LIMIT 1`)).rows[0].id as string;
    let pos = 0;
    const lead = async (l: { name: string; company: string; email?: string; phone?: string; pan?: string; stage: string; source: string; value: number; owner: string; follow?: number | null; lost?: string; entityType?: string }) => {
      const id = uuidv7(); pos += 1024;
      await tx.query(`INSERT INTO lead (id, tenant_id, name, company, email, phone, pan, entity_type, state_code, source, owner_id, stage, position, lost_reason, expected_value_paise, next_followup_on, created_by, created_at, stage_changed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'27',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [id, tenantId, l.name, l.company, l.email ?? null, l.phone ?? null, l.pan ?? null, l.entityType ?? null, l.source, l.owner,
        l.stage, pos, l.lost ?? null, l.value, l.follow == null ? null : day(l.follow), users.partner, at(day(-30), '11:00'), at(day(-5), '12:00')]);
      await tx.query(`INSERT INTO lead_activity (id, tenant_id, lead_id, kind, body, meta, created_by, at) VALUES ($1,$2,$3,'system','Lead created',$4,$5,$6)`, [uuidv7(), tenantId, id, JSON.stringify({ source: l.source }), users.partner, at(day(-30), '11:00')]);
      if (l.stage !== 'new') await tx.query(`INSERT INTO lead_activity (id, tenant_id, lead_id, kind, body, created_by, at) VALUES ($1,$2,$3,'call',$4,$5,$6)`, [uuidv7(), tenantId, id, `Intro call with ${l.name.split(' ')[0]}`, l.owner, at(day(-20), '15:30')]);
      if (['qualified', 'proposal', 'won', 'lost'].includes(l.stage)) await tx.query(`INSERT INTO lead_activity (id, tenant_id, lead_id, kind, body, created_by, at) VALUES ($1,$2,$3,'meeting','Scope discussion at their office',$4,$5)`, [uuidv7(), tenantId, id, l.owner, at(day(-12), '11:00')]);
      return id;
    };
    await lead({ name: 'Rohit Bhatia', company: 'Bhatia Electricals', email: 'rohit@bhatia.example', phone: '+919870000201', stage: 'new', source: 'website', value: 6_000_000, owner: users.manager!, follow: 1 });
    await lead({ name: 'Farah Khan', company: 'Khan Logistics', phone: '+919870000202', stage: 'contacted', source: 'referral', value: 12_000_000, owner: users.partner!, follow: 3 });
    const lDraft = await lead({ name: 'Arvind Nair', company: 'Nair Exports Pvt Ltd', email: 'arvind@nairexports.example', stage: 'proposal', source: 'campaign', value: 18_000_000, owner: users.manager!, entityType: 'PRIVATE_COMPANY' });
    const lSent = await lead({ name: 'Meera Pillai', company: 'Pillai Textiles', email: 'meera@pillai.example', phone: '+919870000204', stage: 'proposal', source: 'referral', value: 9_600_000, owner: users.partner!, follow: 2, entityType: 'PARTNERSHIP' });
    const lWon = await lead({ name: 'Neha Shah', company: 'Navkar Foods LLP', email: 'neha@navkarfoods.example', phone: '+919870000205', pan: 'AAFFN4321K', stage: 'proposal', source: 'existing_client', value: 15_000_000, owner: users.partner!, entityType: 'LLP' });
    const lDecl = await lead({ name: 'Imran Qureshi', company: 'Qureshi Builders', email: 'imran@qureshi.example', stage: 'proposal', source: 'walk_in', value: 7_200_000, owner: users.manager! });
    await lead({ name: 'Kiran Desai', company: 'Desai Pharma', stage: 'lost', source: 'website', value: 4_800_000, owner: users.manager!, lost: 'Chose a firm closer to their plant' });
    await lead({ name: 'Leela Menon', company: 'Menon & Sons', email: 'leela@menon.example', stage: 'qualified', source: 'booking', value: 3_600_000, owner: users.partner!, follow: 0 });

    let seq = 0;
    const proposal = async (leadId: string, title: string, versions: Array<{ lines: ProposalLine[]; sent?: string; nonce?: string }>, extra: { status: string; decided?: string; acceptedName?: string; declined?: string }) => {
      const id = uuidv7(); seq += 1; const number = `PR-${String(seq).padStart(4, '0')}`;
      const last = versions.length; const sentV = [...versions.keys()].filter((k) => versions[k]!.sent).map((k) => k + 1).pop() ?? null;
      await tx.query(`INSERT INTO proposal (id, tenant_id, lead_id, number, title, entity_id, status, current_version, sent_version, accepted_version, sent_at, decided_at, accepted_name, accepted_ip, declined_reason, created_by, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [id, tenantId, leadId, number, title, entity, extra.status, last, sentV, extra.status === 'accepted' ? sentV : null,
        sentV ? at(versions[sentV - 1]!.sent!, '10:00') : null, extra.decided ? at(extra.decided, '16:20') : null, extra.acceptedName ?? null, extra.acceptedName ? '203.0.113.10' : null, extra.declined ?? null, users.partner, at(day(-10), '10:00')]);
      for (const [k, v] of versions.entries()) {
        await tx.query(`INSERT INTO proposal_version (id, tenant_id, proposal_id, version, lines, terms, valid_until, totals, supply_type, link_nonce, sent_at, sent_via, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'intra',$9,$10,$11,$12)`, [uuidv7(), tenantId, id, k + 1, JSON.stringify(v.lines), 'Fees are payable within 15 days of invoice.', day(20),
          JSON.stringify(proposalTotals(v.lines, 'intra')), v.nonce ?? null, v.sent ? at(v.sent, '10:00') : null, v.sent ? 'email' : null, users.partner]);
      }
      await tx.query(`INSERT INTO lead_activity (id, tenant_id, lead_id, kind, body, meta, created_by, at) VALUES ($1,$2,$3,'proposal',$4,$5,$6,$7)`, [uuidv7(), tenantId, leadId, `Proposal ${number} ${extra.status}`, JSON.stringify({ proposalId: id }), users.partner, at(day(-2), '10:00')]);
      return { id, number };
    };
    const L = (k: string, frequency: ProposalLine['frequency'], fee: number, description?: string): ProposalLine => ({ serviceTypeId: st[k]?.id ?? null, description: description ?? st[k]?.name ?? k, frequency, qty: 1, feePaise: fee, gstRate: 18, discountPaise: 0 });
    const gst3b = await rate('GSTR3B'); const gstr1 = await rate('GSTR1');
    await proposal(lDraft, 'Compliance retainer FY 2026-27', [{ lines: [L('GSTR3B', 'monthly', gst3b), L('GSTR1', 'monthly', gstr1)] }], { status: 'draft' });
    await proposal(lSent, 'GST + bookkeeping', [
      { lines: [L('GSTR3B', 'monthly', gst3b), { serviceTypeId: null, description: 'Bookkeeping (Tally)', frequency: 'monthly', qty: 1, feePaise: 900_000, gstRate: 18 }], sent: day(-6), nonce: 'seed-v1-rotated' },
      { lines: [L('GSTR3B', 'monthly', Math.round(gst3b * 0.9)), { serviceTypeId: null, description: 'Bookkeeping (Tally)', frequency: 'monthly', qty: 1, feePaise: 800_000, gstRate: 18 }], sent: day(-2), nonce: 'seed-v2-live' },
    ], { status: 'sent' });
    const wonLines = [L('GSTR3B', 'monthly', gst3b), L('GSTR1', 'monthly', gstr1), { serviceTypeId: null, description: 'LLP annual filing (Form 8 & 11)', frequency: 'annual' as const, qty: 1, feePaise: 1_500_000, gstRate: 18 }];
    const won = await proposal(lWon, 'GST compliance + LLP filings', [{ lines: wonLines, sent: day(-8), nonce: 'seed-won' }], { status: 'accepted', decided: day(-5), acceptedName: 'Neha Shah' });
    await proposal(lDecl, 'Tax audit FY 2025-26', [{ lines: [{ serviceTypeId: null, description: 'Tax audit u/s 44AB', frequency: 'one_time', qty: 1, feePaise: 4_500_000, gstRate: 18 }], sent: day(-9), nonce: 'seed-decl' }],
      { status: 'declined', decided: day(-4), declined: 'Budget this year' });

    // Converted: new client + primary contact + subscriptions with billing frequency + client rates + engagement letter.
    const cid = uuidv7(); const ctid = uuidv7();
    const branch = (await tx.query('SELECT id FROM branch ORDER BY id LIMIT 1')).rows[0].id;
    await tx.query(`INSERT INTO client (id, tenant_id, file_no, name, entity_type, pan, email, phone, source, status, branch_id, partner_id, staff_ids, device_id)
      VALUES ($1,$2,'F-151','Navkar Foods LLP','LLP','AAFFN4321K','neha@navkarfoods.example','+919870000205','lead','active',$3,$4,$5,'seed')`, [cid, tenantId, branch, users.partner, [users.senior]]);
    await tx.query(`INSERT INTO contact (id, tenant_id, client_id, name, email, phone, is_primary, device_id) VALUES ($1,$2,$3,'Neha Shah','neha@navkarfoods.example','+919870000205',true,'seed')`, [ctid, tenantId, cid]);
    const services: string[] = []; const rates: string[] = [];
    for (const l of wonLines.filter((x) => x.serviceTypeId)) {
      const cs = uuidv7(); const rid = uuidv7(); services.push(cs); rates.push(rid);
      await tx.query(`INSERT INTO client_service (id, tenant_id, client_id, service_type_id, start_period, billing_frequency, notes, device_id) VALUES ($1,$2,$3,$4,$5,'monthly',$6,'seed')`, [cs, tenantId, cid, l.serviceTypeId, today.slice(0, 7), `From proposal ${won.number}`]);
      await tx.query(`INSERT INTO billing_rate (id, tenant_id, service_type_id, client_id, amount_paise, effective_from, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [rid, tenantId, l.serviceTypeId, cid, l.feePaise, day(-5), `Proposal ${won.number} v1`, users.partner]);
    }
    const letter = await doc(cid, `Engagement letter ${won.number} - Navkar Foods LLP.pdf`, 'Engagement letters',
      await pdfOf('Engagement Letter', `To: Navkar Foods LLP\nAttention: Neha Shah\n\n${wonLines.map((l) => `- ${l.description} (${l.frequency})`).join('\n')}\n\nFor Sharma & Mehta, Chartered Accountants`), { fy: '2026-27', visible: true });
    await tx.query(`UPDATE lead SET stage = 'won', client_id = $2, converted_at = $3 WHERE id = $1`, [lWon, cid, at(day(-5), '17:00')]);
    await tx.query(`UPDATE proposal SET converted_at = $2, conversion = $3 WHERE id = $1`, [won.id, at(day(-5), '17:00'), JSON.stringify({ clientId: cid, createdClient: true, contactId: ctid, clientServiceIds: services, rateIds: rates, letterDocumentId: letter, esignRequestId: null, portal: null })]);
    await tx.query(`INSERT INTO proposal_counter (tenant_id, next) VALUES ($1,$2)`, [tenantId, seq + 1]);
    return { invoiceClient: g1.id };
  });

  // An issued invoice the director can pay from the portal (mock payment link).
  const audit = new AuditService(); const realtime = new RealtimeService();
  const invoices = new InvoicesService(db, audit, new SyncService(db, audit, realtime, SYNC_TABLES), realtime, new Clock(new Date(`${today}T18:00:00+05:30`)));
  const sys = systemActor(tenantId);
  const { id } = await invoices.create(sys, { clientId: ids.invoiceClient, lines: [{ description: 'GST compliance — September 2026', qty: 1, ratePaise: 250_000 }] });
  await invoices.issue(sys, id, { issueDate: today, dueDate: day(15) });
  await db.tenantTx(tenantId, async (tx: Tx) => {
    const bal = Number((await tx.query('SELECT balance_paise FROM invoice WHERE id = $1', [id])).rows[0].balance_paise);
    await tx.query(`INSERT INTO payment_link (id, tenant_id, invoice_id, provider, provider_link_id, url, amount_paise) VALUES ($1,$2,$3,'mock','plink_demo_portal','https://pay.example.invalid/plink_demo_portal',$4)`, [uuidv7(), tenantId, id, bal]);
  });
}
