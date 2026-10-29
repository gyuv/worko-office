import { addDaysIso, parseNoticeText } from '@worko/domain';
import { createHash } from 'node:crypto';
import { certificatePdf } from '../practice/esign.service.js';
import { storageFactory } from '../storage/storage.js';
import type { DbService } from './db.service.js';
import { uuidv7 } from './ids.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+05:30`);
const fakePdf = (title: string) => Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\nBT (${title}) Tj ET\ntrailer<<>>\n%%EOF\n`);
const NOTICE_TEXT = 'INCOME TAX DEPARTMENT\nNotice under section 148A(b) of the Income-tax Act, 1961\nDIN: ITBA/AST/F/148A/2026-27/1067000001(1)\nPAN: AAAPL1234C\nAssessment Year: 2022-23\nDated: 10/10/2026\nYou are requested to show cause on or before 24/10/2026.';

/**
 * Phase 8 demo data, deterministic for `today`: notices across authorities/statuses (one hearing tomorrow, one overdue, one closed,
 * one appeal) with a pending AI-extraction draft; an audit engagement with programme, mixed sign-offs and a PBC list, a recorded UDIN
 * and a pending one blocking task close; DSCs expiring at 60/30/7 days plus one expired, custody movements; licences due; e-sign
 * requests (one completed with a signed version + certificate, one bulk in progress).
 */
export async function seedPractice8(db: DbService, tenantId: string, today: string) {
  const storage = storageFactory();
  const day = (k: number) => addDaysIso(today, k);
  await db.tenantTx(tenantId, async (tx) => {
    const users = Object.fromEntries((await tx.query(`SELECT u.id, r.key FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id ORDER BY u.id`)).rows.map((r) => [r.key, r.id])) as Record<'partner' | 'manager' | 'senior' | 'article' | 'accountant', string>;
    const clients = (await tx.query(`SELECT c.id, c.name, ct.id AS contact_id, ct.name AS contact FROM client c JOIN contact ct ON ct.client_id = c.id AND ct.is_primary
      WHERE c.status = 'active' ORDER BY c.file_no LIMIT 8`)).rows as Array<{ id: string; name: string; contact_id: string; contact: string }>;
    const doc = async (clientId: string, name: string, category: string, bytes: Buffer, fy: string | null = '2026-27') => {
      const id = uuidv7(); const key = `t/${tenantId}/d/${id}/v1`;
      await storage.put(key, bytes, 'application/pdf');
      await tx.query(`INSERT INTO document (id, tenant_id, client_id, fy, category, name, mime, size, sha256, storage_key, uploaded_by, extracted_text) VALUES ($1,$2,$3,$4,$5,$6,'application/pdf',$7,$8,$9,$10,$11)`,
        [id, tenantId, clientId, fy, category, name, bytes.length, sha(bytes), key, users.senior, null]);
      await tx.query(`INSERT INTO document_version (id, tenant_id, document_id, version, storage_key, size, sha256, mime, uploaded_by) VALUES ($1,$2,$3,1,$4,$5,$6,'application/pdf',$7)`, [uuidv7(), tenantId, id, key, bytes.length, sha(bytes), users.senior]);
      return { id, bytes };
    };
    const task = async (clientId: string, title: string, due: string | null, actBy: string | null, status: string, rule: string, assignee = users.senior) => {
      const id = uuidv7();
      await tx.query(`INSERT INTO task (id, tenant_id, client_id, title, status, priority, statutory_due, act_by, assignee_id, reviewer_id, source, rule_id, created_by, device_id)
        VALUES ($1,$2,$3,$4,$5,'high',$6,$7,$8,$9,'auto',$10,$11,'seed')`, [id, tenantId, clientId, title, status, due, actBy, assignee, users.manager, rule, users.partner]);
      return id;
    };

    // ---------- Notices ----------
    const notice = async (c: number, n: Record<string, unknown>) => {
      const id = uuidv7();
      await tx.query(`INSERT INTO notice (id, tenant_id, client_id, authority, level, section, reference_no, din, title, issue_date, received_on, response_due, assessment_year, financial_year,
          demand_paise, status, outcome, outcome_note, closed_at, assignee_id, reviewer_id, task_id, appeal_of, created_by, device_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'seed')`,
      [id, tenantId, clients[c]!.id, n.authority, n.level, n.section ?? null, n.ref ?? null, n.din ?? null, n.title, n.issue ?? null, n.received, n.due ?? null, n.ay ?? null, n.fy ?? null,
        n.demand ?? 0, n.status, n.outcome ?? null, n.outcomeNote ?? null, n.outcome ? at(day(-2), '17:00') : null, users.senior, users.manager, n.task ?? null, n.appealOf ?? null, users.partner]);
      return id;
    };
    const t1 = await task(clients[0]!.id, 'Reply to Income tax notice u/s 143(2): Scrutiny AY 2025-26', day(10), day(3), 'in_progress', 'notice:seed-1');
    const n1 = await notice(0, { authority: 'income_tax', level: 'assessing_officer', section: '143(2)', din: 'ITBA/AST/S/143(2)/2026-27/1065432100(1)', title: 'Scrutiny AY 2025-26',
      issue: day(-20), received: day(-18), due: day(10), ay: '2025-26', demand: 0, status: 'drafting', task: t1 });
    const t2 = await task(clients[1]!.id, 'Reply to GST notice u/s 73: DRC-01 FY 2022-23', day(-3), day(-6), 'open', 'notice:seed-2');
    await notice(1, { authority: 'gst', level: 'proper_officer', section: '73', ref: 'ZD271026001234X', title: 'DRC-01 show cause FY 2022-23', issue: day(-35), received: day(-33), due: day(-3), fy: '2022-23', demand: 24_000_000, status: 'received', task: t2 });
    await notice(2, { authority: 'tds', level: 'assessing_officer', section: '201(1)', title: 'Short deduction 26Q Q2', issue: day(-50), received: day(-48), due: day(-20), fy: '2025-26', demand: 1_850_000, status: 'submitted' });
    await notice(3, { authority: 'roc', level: 'registrar', section: '137', title: 'Delay in filing AOC-4', issue: day(-120), received: day(-118), due: day(-90), fy: '2024-25', demand: 0, status: 'closed', outcome: 'dropped', outcomeNote: 'Compounded; no penalty' });
    const n5orig = await notice(4, { authority: 'income_tax', level: 'assessing_officer', section: '143(3)', title: 'Assessment order AY 2023-24', issue: day(-200), received: day(-198), ay: '2023-24', demand: 8_500_000, status: 'closed', outcome: 'appeal', outcomeNote: 'Appeal filed before CIT(A)' });
    const n5 = await notice(4, { authority: 'income_tax', level: 'cit_appeals', section: '250', title: 'Appeal AY 2023-24 before CIT(A)', issue: day(-150), received: day(-148), due: day(5), ay: '2023-24', demand: 8_500_000, status: 'hearing', appealOf: n5orig });
    // Hearing tomorrow (prep pending) for N1 + one next week for the appeal; both on the calendar.
    for (const [nid, c, start, venue, link] of [[n1, 0, at(day(1), '11:00'), 'Ward 2(3), Aayakar Bhavan, Pune', null], [n5, 4, at(day(6), '15:30'), null, 'https://vc.incometax.example/hearing/1234']] as const) {
      const ev = uuidv7(); const h = uuidv7();
      await tx.query(`INSERT INTO calendar_event (id, tenant_id, owner_id, kind, title, location, starts_at, ends_at, client_id, attendee_ids, accepted_ids, created_by, device_id)
        VALUES ($1,$2,$3,'hearing',$4,$5,$6,$7,$8,$9,$9,$10,'seed')`, [ev, tenantId, users.senior, `Hearing: ${clients[c]!.name}`, venue ?? link, start, new Date(start.getTime() + 3_600_000), clients[c]!.id, [users.manager], users.partner]);
      await tx.query(`INSERT INTO notice_hearing (id, tenant_id, notice_id, client_id, starts_at, ends_at, venue, virtual_link, owner_id, calendar_event_id, created_by, device_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'seed')`, [h, tenantId, nid, clients[c]!.id, start, new Date(start.getTime() + 3_600_000), venue, link, users.senior, ev, users.partner]);
      await tx.query(`INSERT INTO notification (id, tenant_id, user_id, category, priority, title, body, entity_type, entity_id, fire_at, dedupe_key, device_id)
        VALUES ($1,$2,$3,'notice.hearing','high',$4,'Hearing reminder','notice_hearing',$5,$6,$7,'server')`, [uuidv7(), tenantId, users.senior, `Hearing: ${clients[c]!.name}`, h, new Date(start.getTime() - 86_400_000), `hearing:${h}:1440`]);
    }
    // Extraction drafted from an uploaded notice, waiting for confirmation.
    const nd = await doc(clients[5]!.id, 'Notice 148A(b) AY 2022-23.pdf', 'Notices', Buffer.from(`%PDF-1.4\n${NOTICE_TEXT.split('\n').map((l) => `BT (${l.replace(/[()\\]/g, '')}) Tj ET`).join('\n')}\n%%EOF\n`));
    await tx.query(`INSERT INTO notice_extraction (id, tenant_id, client_id, document_id, document_version, provider, suggestions, created_by) VALUES ($1,$2,$3,$4,1,'mock',$5,$6)`,
      [uuidv7(), tenantId, clients[5]!.id, nd.id, JSON.stringify(parseNoticeText(NOTICE_TEXT)), users.senior]);

    // ---------- Audit workpapers & UDIN ----------
    const sections = [
      { key: 'planning', title: 'Planning', procedures: [{ key: 'engagement_letter', title: 'Engagement letter (SA 210)', evidence: ['Signed engagement letter'] }, { key: 'materiality', title: 'Materiality (SA 320)', evidence: ['Materiality working'] }] },
      { key: 'cash_bank', title: 'Cash and bank', procedures: [{ key: 'bank_conf', title: 'Bank balance confirmations', evidence: ['Confirmations'] }, { key: 'brs', title: 'Bank reconciliations', evidence: ['BRS'] }] },
      { key: 'revenue', title: 'Revenue', procedures: [{ key: 'cutoff', title: 'Sales cut-off testing', evidence: ['Cut-off sample'] }, { key: 'gst_recon', title: 'Revenue vs GSTR-1 reconciliation', evidence: ['Reconciliation'] }] },
      { key: 'reporting', title: 'Reporting', procedures: [{ key: 'caro', title: 'CARO 2020 reporting', evidence: [] }, { key: 'report', title: 'Audit report and UDIN', evidence: ['Signed report'] }] },
    ];
    const prog = uuidv7();
    await tx.query(`INSERT INTO audit_programme (id, tenant_id, name, audit_type, sections, created_by) VALUES ($1,$2,'Statutory audit — company','statutory',$3,$4)`, [prog, tenantId, JSON.stringify(sections), users.partner]);
    await tx.query(`INSERT INTO audit_programme (id, tenant_id, name, audit_type, sections, created_by) VALUES ($1,$2,'Tax audit u/s 44AB','tax_audit_44ab',$3,$4)`,
      [uuidv7(), tenantId, JSON.stringify([{ key: 'form3cd', title: 'Form 3CD', procedures: [{ key: 'clause_44', title: 'Clause 44 GST expenditure break-up', evidence: ['Working'] }] }]), users.partner]);
    // Engagement 1: fieldwork done, task done but UDIN pending → close blocked.
    const auditTask = await task(clients[0]!.id, 'Statutory audit — FY 2025-26', day(30), null, 'done', 'audit:seed-1', users.manager);
    const e1 = uuidv7();
    await tx.query(`INSERT INTO audit_engagement (id, tenant_id, client_id, fy, audit_type, programme_id, programme_snapshot, partner_id, manager_id, task_id, status, created_by)
      VALUES ($1,$2,$3,'2025-26','statutory',$4,$5,$6,$7,$8,'review',$6)`, [e1, tenantId, clients[0]!.id, prog, JSON.stringify(sections), users.partner, users.manager, auditTask]);
    let sort = 0;
    for (const s of sections) for (const p of s.procedures) {
      const pid = uuidv7(); const k = sort;
      const prep = k < 6 ? users.senior : null; const rev = k < 4 ? users.manager : null; const part = k < 2 ? users.partner : null;
      await tx.query(`INSERT INTO audit_procedure (id, tenant_id, engagement_id, section_key, section_title, key, title, required_evidence, sort, prepared_by, prepared_at, reviewed_by, reviewed_at, partner_by, partner_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [pid, tenantId, e1, s.key, s.title, p.key, p.title, p.evidence, sort++, prep, prep ? at(day(-12), '12:00') : null, rev, rev ? at(day(-8), '15:00') : null, part, part ? at(day(-3), '18:00') : null]);
      for (const [lvl, who, when] of [['preparer', prep, day(-12)], ['reviewer', rev, day(-8)], ['partner', part, day(-3)]] as const) {
        if (who) await tx.query(`INSERT INTO audit_signoff_event (id, tenant_id, procedure_id, level, action, user_id, at) VALUES ($1,$2,$3,$4,'signed',$5,$6)`, [uuidv7(), tenantId, pid, lvl, who, at(when, '12:00')]);
      }
      if (k === 0) {
        const wp = await doc(clients[0]!.id, 'Engagement letter FY 2025-26.pdf', 'Audit workpapers', fakePdf('Engagement letter'), '2025-26');
        await tx.query(`INSERT INTO audit_workpaper (id, tenant_id, engagement_id, procedure_id, document_id, document_version, linked_by) VALUES ($1,$2,$3,$4,$5,1,$6)`, [uuidv7(), tenantId, e1, pid, wp.id, users.senior]);
      }
    }
    for (const [title, due, status] of [['Bank statements Apr 2025 – Mar 2026', day(-20), 'accepted'], ['Fixed asset register with additions', day(-10), 'received'], ['Debtor balance confirmations', day(-2), 'requested'], ['Board minutes FY 2025-26', day(7), 'requested']] as const) {
      await tx.query(`INSERT INTO pbc_item (id, tenant_id, engagement_id, client_id, title, due_date, status, received_at, decided_by, decided_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$10)`,
        [uuidv7(), tenantId, e1, clients[0]!.id, title, due, status, status === 'requested' ? null : at(day(-5), '11:00'), status === 'accepted' ? users.senior : null, users.senior]);
    }
    // Engagement 2: tax audit with a recorded UDIN; its task is closed (billed).
    const taxTask = await task(clients[1]!.id, 'Tax audit u/s 44AB — FY 2025-26', day(-15), null, 'done', 'audit:seed-2', users.manager);
    await tx.query(`UPDATE task SET outcome = 'billed', closed_at = $2, closed_by = $3 WHERE id = $1`, [taxTask, at(day(-10), '18:00'), users.partner]);
    const e2 = uuidv7();
    await tx.query(`INSERT INTO audit_engagement (id, tenant_id, client_id, fy, audit_type, partner_id, manager_id, task_id, status, created_by) VALUES ($1,$2,$3,'2025-26','tax_audit_44ab',$4,$5,$6,'closed',$4)`,
      [e2, tenantId, clients[1]!.id, users.partner, users.manager, taxTask]);
    await tx.query(`INSERT INTO udin_record (id, tenant_id, client_id, engagement_id, task_id, udin, document_type, generated_on, membership_no, signing_partner_id, created_by)
      VALUES ($1,$2,$3,$4,$5,'26112233BKCDXY4821','Tax audit report (Form 3CA/3CD)',$6,'112233',$7,$7)`, [uuidv7(), tenantId, clients[1]!.id, e2, taxTask, day(-11), users.partner]);

    // ---------- DSC register (metadata only) ----------
    const dsc = async (c: number | null, name: string, validTo: string, custody: string, custodyUser: string | null, serial: string, staffHolder: string | null = null) => {
      const id = uuidv7();
      await tx.query(`INSERT INTO dsc (id, tenant_id, client_id, holder_kind, contact_id, holder_user_id, holder_name, dsc_class, dsc_type, issuer, serial_no, valid_from, valid_to, custody, custody_user_id, created_by, device_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'Class 3',$8,$9,$10,$11,$12,$13,$14,$15,'seed')`,
      [id, tenantId, c === null ? null : clients[c]!.id, c === null ? 'staff' : 'client_contact', c === null ? null : clients[c]!.contact_id, staffHolder, name, c === null ? 'combo' : 'sign',
        ['eMudhra', 'Capricorn', 'Sify', 'Pantasign'][serial.length % 4], serial, addDaysIso(validTo, -730), validTo, custody, custodyUser, users.partner]);
      await tx.query(`INSERT INTO dsc_custody (id, tenant_id, dsc_id, from_custody, to_custody, purpose, moved_by, moved_at) VALUES ($1,$2,$3,'new','in_office','registered',$4,$5)`, [uuidv7(), tenantId, id, users.partner, at(day(-400), '10:00')]);
      return id;
    };
    await dsc(0, clients[0]!.contact, day(60), 'in_office', null, 'DSC-0060');
    await dsc(1, clients[1]!.contact, day(30), 'in_office', null, 'DSC-00030');
    const d7 = await dsc(2, clients[2]!.contact, day(7), 'with_staff', users.senior, 'DSC-7');
    const dx = await dsc(3, clients[3]!.contact, day(-5), 'with_client', null, 'DSC-EXPIRED');
    await dsc(null, 'Partner (firm DSC)', day(400), 'in_office', null, 'DSC-FIRM-01', users.partner);
    await tx.query(`INSERT INTO dsc_custody (id, tenant_id, dsc_id, from_custody, to_custody, to_user_id, purpose, moved_by, moved_at, acknowledged_at, acknowledged_by) VALUES ($1,$2,$3,'in_office','with_staff',$4,'GSTR-3B filing',$5,$6,$7,$4)`,
      [uuidv7(), tenantId, d7, users.senior, users.partner, at(day(-1), '10:30'), at(day(-1), '10:45')]);
    await tx.query(`INSERT INTO dsc_custody (id, tenant_id, dsc_id, from_custody, to_custody, counterparty, purpose, moved_by, moved_at) VALUES ($1,$2,$3,'in_office','with_client',$4,'Returned to client',$5,$6)`,
      [uuidv7(), tenantId, dx, clients[3]!.contact, users.partner, at(day(-30), '16:00')]);

    // ---------- Licences ----------
    for (const [c, type, num, auth, from, to, renewal] of [
      [0, 'fssai', '11522998000456', 'FSSAI', day(-1800), day(25), null], [1, 'trade_licence', 'PMC/TL/2024/8812', 'Pune Municipal Corporation', day(-320), day(45), day(15)],
      [2, 'udyam', 'UDYAM-MH-26-0012345', 'Ministry of MSME', day(-700), null, null], [3, 'professional_tax', 'PTEC 99151234567', 'Maharashtra Sales Tax Dept', day(-900), null, day(120)],
      [4, 'iec', 'AABCS1234D', 'DGFT', day(-1500), null, null], [5, 'shops_establishment', '2731000315012345', 'Labour Department', day(-1000), day(-10), null],
    ] as const) {
      await tx.query(`INSERT INTO licence (id, tenant_id, client_id, licence_type, number, authority, valid_from, valid_to, renewal_due, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [uuidv7(), tenantId, clients[c]!.id, type, num, auth, from, to, renewal, to && to < today ? 'lapsed' : 'active', users.manager]);
    }

    // ---------- E-signature ----------
    const firm = String((await tx.query('SELECT name FROM tenant WHERE id = $1', [tenantId])).rows[0].name);
    const signedAt = at(day(-2), '14:20');
    // Request 1: completed — signed version 2 + certificate.
    const d1 = await doc(clients[0]!.id, 'Board resolution — auditor appointment.pdf', 'Resolutions', fakePdf('Board resolution'));
    const r1 = uuidv7(); const i1 = uuidv7(); const txn1 = `mock-${i1}`;
    const signed = Buffer.concat([d1.bytes, Buffer.from(`\n% worko-mock-esign ${txn1}\n`)]);
    const k2 = `t/${tenantId}/d/${d1.id}/v2`;
    await storage.put(k2, signed, 'application/pdf');
    await tx.query(`INSERT INTO document_version (id, tenant_id, document_id, version, storage_key, size, sha256, mime, note, uploaded_by) VALUES ($1,$2,$3,2,$4,$5,$6,'application/pdf',$7,NULL)`,
      [uuidv7(), tenantId, d1.id, k2, signed.length, sha(signed), `e-signed (mock txn ${txn1})`]);
    await tx.query('UPDATE document SET current_version = 2, storage_key = $2, size = $3, sha256 = $4 WHERE id = $1', [d1.id, k2, signed.length, sha(signed)]);
    const cert = await certificatePdf({ firm, document: 'Board resolution — auditor appointment.pdf', version: 1, signedVersion: 2, originalSha256: sha(d1.bytes), signedSha256: sha(signed), provider: 'mock', txnId: txn1,
      generatedAt: signedAt, signers: [{ name: clients[0]!.contact, kind: 'contact', maskedId: 'XXXXXXXX4821', nameAsPerId: clients[0]!.contact.toUpperCase(), at: signedAt }] });
    const certDoc = await doc(clients[0]!.id, 'E-sign certificate — Board resolution.pdf', 'E-sign certificates', cert);
    await tx.query(`INSERT INTO esign_request (id, tenant_id, title, mode, provider, status, created_by, created_at, completed_at) VALUES ($1,$2,'Board resolution — auditor appointment','parallel','mock','completed',$3,$4,$5)`, [r1, tenantId, users.manager, at(day(-3), '11:00'), signedAt]);
    await tx.query(`INSERT INTO esign_item (id, tenant_id, request_id, document_id, document_version, client_id, original_sha256, status, provider_txn_id, signed_version, certificate_document_id, signed_sha256, attempts)
      VALUES ($1,$2,$3,$4,1,$5,$6,'signed',$7,2,$8,$9,1)`, [i1, tenantId, r1, d1.id, clients[0]!.id, sha(d1.bytes), txn1, certDoc.id, sha(signed)]);
    await tx.query(`INSERT INTO esign_signer (id, tenant_id, item_id, request_id, ord, kind, contact_id, name, status, link_nonce, notified_at, signed_at, masked_id, signer_name_as_per_id)
      VALUES ($1,$2,$3,$4,1,'contact',$5,$6,'signed','seed-used',$7,$8,'XXXXXXXX4821',$9)`, [uuidv7(), tenantId, i1, r1, clients[0]!.contact_id, clients[0]!.contact, at(day(-3), '11:00'), signedAt, clients[0]!.contact.toUpperCase()]);
    // Request 2: bulk engagement letters — one signed by the client (awaiting partner), one awaiting the client, one failed at the provider.
    const r2 = uuidv7();
    await tx.query(`INSERT INTO esign_request (id, tenant_id, title, bulk, mode, provider, status, created_by, created_at) VALUES ($1,$2,'Engagement letters FY 2026-27',true,'sequential','mock','in_progress',$3,$4)`, [r2, tenantId, users.partner, at(day(-1), '10:00')]);
    for (const [n, c] of [[0, 5], [1, 6], [2, 7]] as const) {
      const d = await doc(clients[c]!.id, `Engagement letter FY 2026-27 — ${clients[c]!.name}.pdf`, 'Engagement letters', fakePdf(`Engagement letter ${n}`));
      const iid = uuidv7(); const failed = n === 2;
      await tx.query(`INSERT INTO esign_item (id, tenant_id, request_id, document_id, document_version, client_id, original_sha256, status, provider_txn_id, attempts, error) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,1,$9)`,
        [iid, tenantId, r2, d.id, clients[c]!.id, sha(d.bytes), failed ? 'failed' : 'sent', failed ? null : `mock-${iid}`, failed ? 'provider_unavailable' : null]);
      await tx.query(`INSERT INTO esign_signer (id, tenant_id, item_id, request_id, ord, kind, contact_id, name, status, link_nonce, notified_at, signed_at, masked_id)
        VALUES ($1,$2,$3,$4,1,'contact',$5,$6,$7,$8,$9,$10,$11)`, [uuidv7(), tenantId, iid, r2, clients[c]!.contact_id, clients[c]!.contact, n === 0 ? 'signed' : failed ? 'pending' : 'notified',
        `seed-${n}`, failed ? null : at(day(-1), '10:01'), n === 0 ? at(day(-1), '16:40') : null, n === 0 ? 'XXXXXXXX7710' : null]);
      if (!failed) await tx.query(`INSERT INTO esign_signer (id, tenant_id, item_id, request_id, ord, kind, user_id, name, status, link_nonce, notified_at) VALUES ($1,$2,$3,$4,2,'staff',$5,'Partner',$6,$7,$8)`,
        [uuidv7(), tenantId, iid, r2, users.partner, n === 0 ? 'notified' : 'pending', `seed-p${n}`, n === 0 ? at(day(-1), '16:41') : null]);
    }
  });
}

