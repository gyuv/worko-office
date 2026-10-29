import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  can, clientCtx, diffProposalVersions, ENTITY_TYPES, formatINR, isValidPan, normalizeAddress, placeholdersOf, proposalAcceptError, proposalTotals, renderTemplate,
  supplyTypeOf, type CommChannel, type EntityType, type PortalGrants, type ProposalFrequency, type ProposalLine, type ProposalStatus,
} from '@worko/domain';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import PDFDocument from 'pdfkit';
import type { RequestActor } from '../auth/context.js';
import { publicBase } from '../billing/providers.js';
import { CommService } from '../comm/comm.service.js';
import { Clock } from '../common/clock.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { DocumentsService } from '../documents/documents.service.js';
import { insertNotifications } from '../notifications/insert.js';
import { EsignService } from '../practice/esign.service.js';
import { PortalAdminService } from '../portal/admin.service.js';
import { loadPortalSettings } from '../portal/common.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { ymd } from '../tasks/scope.js';
import { leadCtx, leadScopeSql, LeadsService } from './leads.service.js';
import { Params } from '../clients/scope.js';
import { AuditService } from '../audit/audit.service.js';

export type LineIn = { serviceTypeId?: string | null; description?: string | null; frequency: ProposalFrequency; qty?: number; feePaise?: number | null; gstRate?: number | null; discountPaise?: number };
type ProposalIn = { title: string; entityId?: string | null; placeOfSupply?: string | null; lines: LineIn[]; terms?: string | null; validUntil?: string | null };
const n = (x: unknown) => Number(x ?? 0);
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// ---------- Signed e-accept links: tenant × proposal × version × per-send nonce (rotated on every send/withdraw) ----------
const linkKey = () => createHash('sha256').update(`proposal-link:${process.env.JWT_SIGNING_KEY ?? 'worko-dev-only-signing-key'}`).digest();
export function proposalLink(tenantId: string, proposalId: string, version: number, nonce: string) {
  const payload = Buffer.from(JSON.stringify({ t: tenantId, p: proposalId, v: version, n: nonce })).toString('base64url');
  return `${payload}.${createHmac('sha256', linkKey()).update(payload).digest('base64url')}`;
}
function verifyLink(token: string): { t: string; p: string; v: number; n: string } | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expect = createHmac('sha256', linkKey()).update(payload).digest(); const got = Buffer.from(sig, 'base64url');
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { t: string; p: string; v: number; n: string };
    return isUuid(p.t) && isUuid(p.p) && Number.isInteger(p.v) && typeof p.n === 'string' ? p : null;
  } catch { return null; }
}

/** Proposals (D132): versioned (a sent version is immutable — editing creates the next), e-accept by signed link, one-click idempotent conversion. */
@Injectable()
export class ProposalsService {
  constructor(private db: DbService, private audit: AuditService, private leads: LeadsService, private comm: CommService, private docs: DocumentsService, private esign: EsignService,
    private portal: PortalAdminService, private realtime: RealtimeService, private clock: Clock) {}

  private async load(tx: Tx, a: RequestActor, id: string, action: 'view' | 'edit' | 'approve', lock = false) {
    if (!isUuid(id)) throw new NotFoundException();
    const p = (await tx.query(`SELECT * FROM proposal WHERE id = $1 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
    if (!p) throw new NotFoundException();
    const l = await this.leads.loadLead(tx, a, p.lead_id, action === 'approve' ? 'view' : action);
    if (action === 'approve' && !can(a, 'leads', 'approve', leadCtx(l))) throw new ForbiddenException();
    return { p, l };
  }

  /** Fees from the rate table (firm-wide rate on the date) unless overridden; GST from the service's rate or billing default. */
  private async resolveLines(tx: Tx, lines: LineIn[], onDate: string): Promise<ProposalLine[]> {
    const def = Number((await tx.query('SELECT default_gst_rate FROM billing_settings WHERE tenant_id = current_tenant()')).rows[0]?.default_gst_rate ?? 18);
    const outL: ProposalLine[] = [];
    for (const [i, l] of lines.entries()) {
      let description = l.description?.trim() ?? ''; let fee = l.feePaise ?? null; let gst = l.gstRate ?? null;
      if (l.serviceTypeId) {
        const s = (await tx.query('SELECT name, gst_rate FROM service_type WHERE id = $1 AND deleted_at IS NULL AND active', [l.serviceTypeId])).rows[0];
        if (!s) throw new BadRequestException({ message: `Line ${i + 1}: unknown service`, code: 'invalid:serviceTypeId' });
        description ||= s.name;
        gst ??= s.gst_rate === null ? def : Number(s.gst_rate);
        if (fee === null) {
          const r = (await tx.query(`SELECT amount_paise FROM billing_rate WHERE service_type_id = $1 AND client_id IS NULL AND group_id IS NULL AND deleted_at IS NULL
            AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date) ORDER BY effective_from DESC LIMIT 1`, [l.serviceTypeId, onDate])).rows[0];
          if (!r) throw new BadRequestException({ message: `Line ${i + 1}: no rate for this service — enter a fee`, code: 'no_rate' });
          fee = n(r.amount_paise);
        }
      }
      if (!description || fee === null) throw new BadRequestException({ message: `Line ${i + 1}: description and fee are required`, code: 'invalid:lines' });
      outL.push({ serviceTypeId: l.serviceTypeId ?? null, description: description.slice(0, 500), frequency: l.frequency, qty: l.qty ?? 1, feePaise: fee, gstRate: gst ?? def, discountPaise: l.discountPaise ?? 0 });
    }
    return outL;
  }

  private async supply(tx: Tx, p: { entity_id: string | null; place_of_supply: string | null }, lead: Record<string, unknown>) {
    const e = (await tx.query(`SELECT id, gstin, state_code, name FROM firm_entity WHERE deleted_at IS NULL AND ($1::uuid IS NULL AND id = COALESCE((SELECT default_entity_id FROM billing_settings WHERE tenant_id = current_tenant()), id) OR id = $1)
      ORDER BY active DESC, id LIMIT 1`, [p.entity_id])).rows[0];
    if (!e) throw new BadRequestException({ message: 'Set up a billing entity first', code: 'no_entity' });
    return { entity: e, supply: supplyTypeOf(e.gstin, e.state_code, p.place_of_supply ?? (lead.state_code as string) ?? e.state_code) };
  }

  private async writeVersion(tx: Tx, a: RequestActor, proposalId: string, version: number, lines: ProposalLine[], supply: ReturnType<typeof supplyTypeOf>, terms: string | null, validUntil: string | null, insert: boolean) {
    const totals = proposalTotals(lines, supply);
    if (insert) {
      await tx.query(`INSERT INTO proposal_version (id, tenant_id, proposal_id, version, lines, terms, valid_until, totals, supply_type, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [uuidv7(), a.tenantId, proposalId, version, JSON.stringify(lines), terms, validUntil, JSON.stringify(totals), supply, a.userId]);
    } else {
      await tx.query(`UPDATE proposal_version SET lines = $3, terms = $4, valid_until = $5, totals = $6, supply_type = $7 WHERE proposal_id = $1 AND version = $2`,
        [proposalId, version, JSON.stringify(lines), terms, validUntil, JSON.stringify(totals), supply]);
    }
    return totals;
  }

  async create(a: RequestActor, leadId: string, b: ProposalIn) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const l = await this.leads.loadLead(tx, a, leadId, 'create', true);
      if (['won', 'lost'].includes(l.stage)) throw new ConflictException({ message: 'The lead is closed', code: 'lead_closed' });
      const id = uuidv7();
      const seq = (await tx.query(`INSERT INTO proposal_counter (tenant_id, next) VALUES ($1, 2) ON CONFLICT (tenant_id) DO UPDATE SET next = proposal_counter.next + 1 RETURNING next - 1 AS n`, [a.tenantId])).rows[0].n;
      const number = `PR-${String(seq).padStart(4, '0')}`;
      const settings = await this.leads.settingsTx(tx);
      const { entity, supply } = await this.supply(tx, { entity_id: b.entityId ?? null, place_of_supply: b.placeOfSupply ?? null }, l);
      await tx.query(`INSERT INTO proposal (id, tenant_id, lead_id, number, title, entity_id, place_of_supply, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, a.tenantId, leadId, number, b.title, entity.id, b.placeOfSupply ?? null, a.userId]);
      const lines = await this.resolveLines(tx, b.lines, this.clock.todayIst());
      const totals = await this.writeVersion(tx, a, id, 1, lines, supply, b.terms ?? settings.defaultTerms, b.validUntil ?? null, true);
      if (['new', 'contacted', 'qualified'].includes(l.stage)) {
        await tx.query(`UPDATE lead SET stage = 'proposal', stage_changed_at = $2, version = version + 1 WHERE id = $1`, [leadId, this.clock.now()]);
        await this.leads.activity(tx, a.tenantId, leadId, 'stage', null, a.userId, { from: l.stage, to: 'proposal', auto: true });
      }
      await this.leads.activity(tx, a.tenantId, leadId, 'proposal', `Proposal ${number} drafted`, a.userId, { proposalId: id });
      await this.leads.rec(tx, a, 'proposal.created', 'proposal', id, { leadId, lines: lines.length, firstYearPaise: totals.firstYear.totalPaise });
      return { id, number, version: 1, totals };
    });
  }

  list(a: RequestActor, q: { leadId?: string; status?: ProposalStatus }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const where = ['x.deleted_at IS NULL', leadScopeSql(a, 'view', p)];
      if (q.leadId) where.push(`x.lead_id = ${p.add(q.leadId)}`);
      if (q.status) where.push(`x.status = ${p.add(q.status)}`);
      return (await tx.query(`SELECT x.id, x.number, x.title, x.status, x.lead_id AS "leadId", l.name AS "leadName", l.company, x.current_version AS "currentVersion", x.sent_version AS "sentVersion",
          x.accepted_version AS "acceptedVersion", x.sent_at AS "sentAt", x.decided_at AS "decidedAt", x.converted_at AS "convertedAt", v.totals, v.valid_until AS "validUntil"
        FROM proposal x JOIN lead l ON l.id = x.lead_id JOIN proposal_version v ON v.proposal_id = x.id AND v.version = x.current_version
        WHERE ${where.join(' AND ')} ORDER BY x.created_at DESC LIMIT 500`, p.values)).rows.map((r) => ({ ...r, validUntil: ymd(r.validUntil) }));
    });
  }

  private versionOut(v: Record<string, unknown>) {
    return { version: v.version, lines: v.lines, terms: v.terms, validUntil: ymd(v.valid_until), totals: v.totals, supplyType: v.supply_type, sentAt: v.sent_at, sentVia: v.sent_via, createdAt: v.created_at };
  }

  get(a: RequestActor, id: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const { p, l } = await this.load(tx, a, id, 'view');
      const versions = (await tx.query('SELECT * FROM proposal_version WHERE proposal_id = $1 ORDER BY version', [id])).rows.map((v) => this.versionOut(v));
      return { id: p.id, number: p.number, title: p.title, leadId: p.lead_id, leadName: l.name, company: l.company, status: this.effectiveStatus(p, versions.find((v) => v.version === p.current_version)?.validUntil ?? null),
        entityId: p.entity_id, placeOfSupply: p.place_of_supply, currentVersion: p.current_version, sentVersion: p.sent_version, acceptedVersion: p.accepted_version,
        sentAt: p.sent_at, decidedAt: p.decided_at, acceptedName: p.accepted_name, declinedReason: p.declined_reason, convertedAt: p.converted_at, conversion: p.conversion, versions };
    });
  }

  private effectiveStatus(p: Record<string, unknown>, validUntil: string | null): ProposalStatus {
    return p.status === 'sent' && validUntil && validUntil < this.clock.todayIst() ? 'expired' : (p.status as ProposalStatus);
  }

  async diff(a: RequestActor, id: string, from: number, to: number) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      await this.load(tx, a, id, 'view');
      const vs = (await tx.query('SELECT * FROM proposal_version WHERE proposal_id = $1 AND version = ANY($2::int[])', [id, [from, to]])).rows;
      const f = vs.find((v) => v.version === from); const t = vs.find((v) => v.version === to);
      if (!f || !t) throw new NotFoundException();
      return diffProposalVersions({ lines: f.lines, terms: f.terms, validUntil: ymd(f.valid_until) }, { lines: t.lines, terms: t.terms, validUntil: ymd(t.valid_until) });
    });
  }

  /** Draft edits change the current version in place; editing a sent proposal creates the next version (back to draft — the old link can no longer be accepted). */
  async update(a: RequestActor, id: string, b: Partial<ProposalIn>) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const { p, l } = await this.load(tx, a, id, 'edit', true);
      if (!['draft', 'sent'].includes(p.status)) throw new ConflictException({ message: `A ${p.status} proposal can't be edited`, code: 'proposal_closed' });
      const v = (await tx.query('SELECT * FROM proposal_version WHERE proposal_id = $1 AND version = $2', [id, p.current_version])).rows[0];
      if (b.title !== undefined || b.entityId !== undefined || b.placeOfSupply !== undefined) {
        await tx.query(`UPDATE proposal SET title = COALESCE($2, title), entity_id = CASE WHEN $3 THEN $4::uuid ELSE entity_id END, place_of_supply = CASE WHEN $5 THEN $6 ELSE place_of_supply END, version = version + 1 WHERE id = $1`,
          [id, b.title ?? null, b.entityId !== undefined, b.entityId ?? null, b.placeOfSupply !== undefined, b.placeOfSupply ?? null]);
      }
      const cur = (await tx.query('SELECT entity_id, place_of_supply FROM proposal WHERE id = $1', [id])).rows[0];
      const { supply } = await this.supply(tx, cur, l);
      const lines = b.lines ? await this.resolveLines(tx, b.lines, this.clock.todayIst()) : (v.lines as ProposalLine[]);
      const terms = b.terms !== undefined ? b.terms : v.terms;
      const validUntil = b.validUntil !== undefined ? b.validUntil : ymd(v.valid_until);
      const newVersion = !!v.sent_at;
      const version = newVersion ? p.current_version + 1 : p.current_version;
      const totals = await this.writeVersion(tx, a, id, version, lines, supply, terms, validUntil, newVersion);
      if (newVersion) {
        await tx.query(`UPDATE proposal SET current_version = $2, status = 'draft', version = version + 1, updated_at = now() WHERE id = $1`, [id, version]);
        await this.leads.activity(tx, a.tenantId, p.lead_id, 'proposal', `Proposal ${p.number} revised (v${version})`, a.userId, { proposalId: id, version });
      }
      await this.leads.rec(tx, a, 'proposal.updated', 'proposal', id, { version, newVersion, fields: Object.keys(b) });
      return { version, newVersion, totals };
    });
  }

  /** Sends the current version: freezes it, rotates its link nonce, and messages the lead through the comm pipeline (template optional). */
  async send(a: RequestActor, id: string, b: { channel: CommChannel; templateId?: string | null }) {
    const now = this.clock.now();
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const { p, l } = await this.load(tx, a, id, 'edit', true);
      if (!['draft', 'sent'].includes(p.status)) throw new ConflictException({ message: `A ${p.status} proposal can't be sent`, code: 'proposal_closed' });
      const settings = await this.leads.settingsTx(tx);
      const v = (await tx.query('SELECT * FROM proposal_version WHERE proposal_id = $1 AND version = $2 FOR UPDATE', [id, p.current_version])).rows[0];
      let validUntil = ymd(v.valid_until);
      if (!v.sent_at && !validUntil) {
        validUntil = new Date(Date.parse(`${this.clock.todayIst()}T00:00:00Z`) + settings.proposalValidityDays * 86_400_000).toISOString().slice(0, 10);
        await tx.query('UPDATE proposal_version SET valid_until = $2 WHERE id = $1', [v.id, validUntil]);
      }
      if (validUntil && validUntil < this.clock.todayIst()) throw new ConflictException({ message: 'Validity date has passed — edit the proposal', code: 'expired' });
      const address = normalizeAddress(b.channel, b.channel === 'email' ? l.email : l.phone);
      if (!address) throw new ConflictException({ message: 'The lead has no address on that channel', code: 'no_address' });
      const nonce = randomBytes(12).toString('base64url');
      await tx.query(`UPDATE proposal_version SET link_nonce = $2, sent_at = COALESCE(sent_at, $3), sent_via = $4 WHERE id = $1`, [v.id, nonce, now, b.channel]);
      await tx.query(`UPDATE proposal SET status = 'sent', sent_version = $2, sent_at = $3, version = version + 1, updated_at = now() WHERE id = $1`, [id, p.current_version, now]);
      const link = `${publicBase()}/proposals/public/${proposalLink(a.tenantId, id, p.current_version, nonce)}`;
      const t = (await tx.query('SELECT name FROM tenant WHERE id = current_tenant()')).rows[0];
      const firm = (await loadPortalSettings(tx)).displayName ?? t.name;
      const vars: Record<string, string> = { 'contact.name': l.name, 'client.name': l.company ?? l.name, 'firm.name': firm, link, due_date: validUntil ?? '', service: p.title };
      let text = `Dear ${l.name}, please find our proposal ${p.number} (${p.title}) from ${firm}. Review and accept online: ${link}. Valid until ${validUntil}.`;
      let subject: string | null = b.channel === 'email' ? `Proposal ${p.number} from ${firm}` : null; let templateId: string | null = null;
      if (b.templateId) {
        const tpl = (await tx.query('SELECT * FROM comm_template WHERE id = $1 AND deleted_at IS NULL', [b.templateId])).rows[0];
        if (!tpl || tpl.channel !== b.channel) throw new BadRequestException({ message: 'Template not found for this channel', code: 'bad_template' });
        if (tpl.status !== 'approved') throw new ConflictException({ message: 'Template is not approved', code: 'template_not_approved' });
        const rr = renderTemplate(tpl.body, Object.fromEntries(placeholdersOf(tpl.body).map((k) => [k, vars[k]])));
        if (rr.missing.length) throw new BadRequestException({ message: 'Missing template variables', code: 'missing_variables', issues: rr.missing });
        text = rr.text; templateId = tpl.id; subject = tpl.subject ? renderTemplate(tpl.subject, vars).text : subject;
      }
      const q = await this.comm.queueTx(tx, a.tenantId, { clientId: l.client_id ?? null, contactId: null, channel: b.channel, address, category: 'transactional', subject, text, templateId,
        createdBy: a.userId, now, meta: { proposalId: id, leadId: l.id, version: p.current_version }, format: 'text' });
      if ('error' in q) throw new ConflictException({ message: `Not sent: ${q.error}`, code: q.error }); // rolls back: nothing marked sent
      await this.leads.activity(tx, a.tenantId, l.id, 'proposal', `Proposal ${p.number} v${p.current_version} sent by ${b.channel}`, a.userId, { proposalId: id, version: p.current_version, messageId: q.id });
      await this.leads.rec(tx, a, 'proposal.sent', 'proposal', id, { version: p.current_version, channel: b.channel, messageId: q.id });
      return { version: p.current_version, link, messageId: q.id, sendAt: q.sendAt };
    });
    const status = r.sendAt > now ? 'queued' : await this.comm.deliverNow(a.tenantId, r.messageId, now);
    return { version: r.version, link: r.link, messageId: r.messageId, status };
  }

  async withdraw(a: RequestActor, id: string) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const { p } = await this.load(tx, a, id, 'edit', true);
      if (!['draft', 'sent'].includes(p.status)) throw new ConflictException({ message: `A ${p.status} proposal can't be withdrawn`, code: 'proposal_closed' });
      await tx.query(`UPDATE proposal_version SET link_nonce = NULL WHERE proposal_id = $1`, [id]);
      await tx.query(`UPDATE proposal SET status = 'withdrawn', decided_at = $2, version = version + 1 WHERE id = $1`, [id, this.clock.now()]);
      await this.leads.activity(tx, a.tenantId, p.lead_id, 'proposal', `Proposal ${p.number} withdrawn`, a.userId, { proposalId: id });
      await this.leads.rec(tx, a, 'proposal.withdrawn', 'proposal', id);
    });
  }

  // ---------- Public e-accept ----------
  private async openToken(tx: Tx, token: string, lock = false) {
    const t = verifyLink(token);
    if (!t) return null;
    const v = (await tx.query('SELECT * FROM proposal_version WHERE proposal_id = $1 AND version = $2', [t.p, t.v])).rows[0];
    if (!v?.link_nonce || v.link_nonce.length !== t.n.length || !timingSafeEqual(Buffer.from(v.link_nonce), Buffer.from(t.n))) return null;
    const p = (await tx.query(`SELECT * FROM proposal WHERE id = $1 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`, [t.p])).rows[0];
    return p ? { t, v, p } : null;
  }
  private tenantOf(token: string) { const t = verifyLink(token); if (!t) throw new NotFoundException(); return t.t; }

  async publicView(token: string) {
    const tenantId = this.tenantOf(token);
    return this.db.tenantTx(tenantId, async (tx) => {
      const o = await this.openToken(tx, token);
      if (!o) throw new NotFoundException();
      const { t, v, p } = o;
      const l = (await tx.query('SELECT name, company FROM lead WHERE id = $1', [p.lead_id])).rows[0];
      const tn = (await tx.query('SELECT name FROM tenant WHERE id = current_tenant()')).rows[0];
      const s = await loadPortalSettings(tx);
      const err = proposalAcceptError({ status: p.status, sentVersion: p.sent_version, currentVersion: p.current_version, validUntil: ymd(v.valid_until) }, t.v, this.clock.todayIst());
      const state = p.status === 'accepted' && p.accepted_version === t.v ? 'accepted' : p.status === 'declined' && p.sent_version === t.v ? 'declined' : err === 'already_decided' ? 'superseded' : err ?? 'open';
      return { firm: s.displayName ?? tn.name, accent: s.accent, number: p.number, title: p.title, version: t.v, preparedFor: l?.company ?? l?.name,
        lines: (v.lines as ProposalLine[]).map((x) => ({ description: x.description, frequency: x.frequency, qty: x.qty, feePaise: x.feePaise, discountPaise: x.discountPaise ?? 0, gstRate: x.gstRate })),
        totals: v.totals, terms: v.terms, validUntil: ymd(v.valid_until), state, acceptable: state === 'open' };
    });
  }

  /** Accept / decline: only the latest sent version, before expiry, once (row lock + status check make replays a 409). */
  async decide(token: string, b: { accept: true; name: string } | { accept: false; reason: string }, meta: { ip: string | null; userAgent?: string }) {
    const tenantId = this.tenantOf(token);
    const r = await this.db.tenantTx(tenantId, async (tx) => {
      const o = await this.openToken(tx, token, true);
      if (!o) throw new NotFoundException();
      const { t, v, p } = o;
      const today = this.clock.todayIst(); const now = this.clock.now();
      const err = proposalAcceptError({ status: p.status, sentVersion: p.sent_version, currentVersion: p.current_version, validUntil: ymd(v.valid_until) }, t.v, today);
      if (err === 'expired' && p.status === 'sent') await tx.query(`UPDATE proposal SET status = 'expired', version = version + 1 WHERE id = $1`, [p.id]);
      if (err) return { error: err };
      if (b.accept) {
        await tx.query(`UPDATE proposal SET status = 'accepted', accepted_version = $2, decided_at = $3, accepted_name = $4, accepted_ip = $5, accepted_ua = $6, version = version + 1, updated_at = now() WHERE id = $1`,
          [p.id, t.v, now, b.name, meta.ip, meta.userAgent?.slice(0, 300) ?? null]);
      } else {
        await tx.query(`UPDATE proposal SET status = 'declined', decided_at = $2, declined_reason = $3, version = version + 1, updated_at = now() WHERE id = $1`, [p.id, now, b.reason]);
      }
      const action = b.accept ? 'accepted' : 'declined';
      await this.leads.activity(tx, tenantId, p.lead_id, 'proposal', `Proposal ${p.number} v${t.v} ${action} online`, null, { proposalId: p.id, version: t.v });
      // Audit: metadata only — the typed name and decline reason stay on the proposal row, not in the log.
      await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'public', action: `proposal.${action}`, entity: 'proposal', entityId: p.id, diff: { version: t.v }, ip: meta.ip });
      const l = (await tx.query('SELECT owner_id FROM lead WHERE id = $1', [p.lead_id])).rows[0];
      const cur = l?.owner_id ? (await insertNotifications(tx, tenantId, { userIds: [l.owner_id], category: 'proposal.decided', priority: b.accept ? 'high' : 'normal',
        title: `Proposal ${p.number} ${action}`, entityType: 'proposal', entityId: p.id, dedupeKey: `proposal-decided:${p.id}` })).cursor : 0;
      return { status: action, cursor: cur };
    });
    if ('error' in r) throw new ConflictException({ message: `This proposal can't be ${b.accept ? 'accepted' : 'declined'}: ${r.error}`, code: r.error });
    if (r.cursor) this.realtime.publish({ type: 'changed', tenantId, cursor: r.cursor });
    return { status: r.status };
  }

  // ---------- Conversion ----------
  /**
   * One click: accepted proposal → client (or an existing one after the duplicate check), primary contact, subscriptions with billing
   * frequency, client-specific rate rows, engagement letter PDF (documents), optional e-sign and portal invite. Idempotent: the proposal
   * row lock + converted_at make a second call return the first result; a missing letter is (re)generated on retry.
   */
  async convert(a: RequestActor, id: string, b: { clientId?: string | null; ignoreDuplicates?: boolean; entityType?: EntityType | null; startPeriod?: string | null; inviteToPortal?: boolean; sendForEsign?: boolean; portalGrants?: PortalGrants }) {
    const now = this.clock.now(); const today = this.clock.todayIst();
    const res = await this.db.tenantTx(a.tenantId, async (tx) => {
      const { p, l } = await this.load(tx, a, id, 'approve', true);
      if (p.converted_at) return { already: true, conversion: p.conversion as Record<string, unknown>, cursor: 0 };
      if (p.status !== 'accepted') throw new ConflictException({ message: 'Only an accepted proposal can be converted', code: 'not_accepted' });
      const v = (await tx.query('SELECT * FROM proposal_version WHERE proposal_id = $1 AND version = $2', [id, p.accepted_version])).rows[0];
      let clientId = b.clientId ?? l.client_id ?? null; let created = false;
      if (clientId) {
        const c = (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [clientId])).rows[0];
        const ctx = c && clientCtx({ branchId: c.branch_id, partnerId: c.partner_id, managerId: c.manager_id, teamId: c.team_id, staffIds: c.staff_ids, groupIds: c.group_ids, sensitive: c.sensitive, allowedUserIds: c.allowed_user_ids });
        if (!c || !can(a, 'clients', 'view', ctx)) throw new NotFoundException('Client not found');
        if (!can(a, 'clients', 'edit', ctx)) throw new ForbiddenException();
      } else {
        const dup = await this.leads.duplicatesTx(tx, a, { pan: l.pan, gstin: l.gstin, email: l.email, phone: l.phone });
        if ((dup.clients.length || dup.hiddenClients) && !b.ignoreDuplicates) throw new ConflictException({ message: 'Possible existing client', code: 'duplicate_client', candidates: dup.clients, hidden: dup.hiddenClients });
        const entityType = b.entityType ?? l.entity_type;
        if (!entityType || !(ENTITY_TYPES as readonly string[]).includes(entityType)) throw new BadRequestException({ message: 'Choose the entity type', code: 'entity_type_required' });
        if (l.pan && !isValidPan(l.pan)) throw new BadRequestException({ message: 'Invalid PAN on the lead', code: 'invalid:pan' });
        const vis = { branchId: a.branchId, partnerId: null, managerId: null, teamId: null, staffIds: [...new Set([l.owner_id, a.userId].filter(Boolean))] as string[], groupIds: [], sensitive: false, allowedUserIds: [] };
        if (!can(a, 'clients', 'create', clientCtx(vis))) throw new ForbiddenException('Cannot create clients');
        clientId = uuidv7(); created = true;
        await tx.query(`INSERT INTO client (id, tenant_id, name, entity_type, pan, email, phone, source, status, branch_id, staff_ids, updated_by, device_id, field_versions)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'lead','active',$8,$9,$10,$11,'{}')`, [clientId, a.tenantId, l.company ?? l.name, entityType, l.pan ?? (l.gstin ? String(l.gstin).slice(2, 12) : null), l.email, l.phone, a.branchId, vis.staffIds, a.userId, a.deviceId]);
        if (l.gstin) {
          try {
            await tx.query('SAVEPOINT reg');
            await tx.query(`INSERT INTO client_registration (id, tenant_id, client_id, kind, number, state_code, is_primary, updated_by, field_versions) VALUES ($1,$2,$3,'GSTIN',$4,$5,true,$6,'{}')`,
              [uuidv7(), a.tenantId, clientId, l.gstin, String(l.gstin).slice(0, 2), a.userId]);
          } catch { await tx.query('ROLLBACK TO SAVEPOINT reg'); throw new ConflictException({ message: 'That GSTIN already belongs to another client', code: 'duplicate_client' }); }
        }
        // Metadata only (no names/addresses): the client row itself is the record.
        await this.leads.rec(tx, a, 'client.created', 'client', clientId, { source: 'proposal', proposalId: id, leadId: l.id });
      }
      // Primary contact from the lead (reuse an existing contact with the same email/phone).
      let contactId = (await tx.query(`SELECT id FROM contact WHERE client_id = $1 AND deleted_at IS NULL AND ((lower(email) = lower($2)) OR (phone = $3)) LIMIT 1`, [clientId, l.email, l.phone])).rows[0]?.id as string | undefined;
      if (!contactId && (l.email || l.phone || created)) {
        contactId = uuidv7();
        await tx.query(`INSERT INTO contact (id, tenant_id, client_id, name, email, phone, is_primary, updated_by, device_id, field_versions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}')`,
          [contactId, a.tenantId, clientId, l.name, l.email, l.phone, created, a.userId, a.deviceId]);
      }
      const startPeriod = b.startPeriod ?? today.slice(0, 7);
      const services: string[] = []; const rates: string[] = [];
      for (const line of v.lines as ProposalLine[]) {
        if (!line.serviceTypeId) continue;
        const bf = line.frequency === 'one_time' ? null : line.frequency;
        let cs = (await tx.query('SELECT id FROM client_service WHERE client_id = $1 AND service_type_id = $2 AND deleted_at IS NULL', [clientId, line.serviceTypeId])).rows[0]?.id as string | undefined;
        if (!cs) {
          cs = uuidv7();
          await tx.query(`INSERT INTO client_service (id, tenant_id, client_id, service_type_id, start_period, billing_frequency, active, notes, updated_by, device_id, field_versions)
            VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,'{}')`, [cs, a.tenantId, clientId, line.serviceTypeId, startPeriod, bf, `From proposal ${p.number}`, a.userId, a.deviceId]);
        }
        services.push(cs);
        const rid = uuidv7();
        await tx.query(`INSERT INTO billing_rate (id, tenant_id, service_type_id, client_id, amount_paise, effective_from, notes, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
          [rid, a.tenantId, line.serviceTypeId, clientId, Math.round(line.qty * line.feePaise) - (line.discountPaise ?? 0), today, `Proposal ${p.number} v${p.accepted_version}`, a.userId]);
        rates.push(rid);
      }
      await tx.query(`UPDATE lead SET stage = 'won', client_id = $2, converted_at = $3, lost_reason = NULL, stage_changed_at = $3, version = version + 1 WHERE id = $1`, [l.id, clientId, now]);
      await this.leads.activity(tx, a.tenantId, l.id, 'stage', `Converted from ${p.number}`, a.userId, { from: l.stage, to: 'won', clientId });
      const conversion = { clientId, createdClient: created, contactId: contactId ?? null, clientServiceIds: services, rateIds: rates, letterDocumentId: null as string | null, esignRequestId: null as string | null, portal: null as unknown };
      await tx.query(`UPDATE proposal SET converted_at = $2, conversion = $3, version = version + 1 WHERE id = $1`, [id, now, JSON.stringify(conversion)]);
      await this.leads.rec(tx, a, 'proposal.converted', 'proposal', id, { clientId, createdClient: created, services: services.length, rates: rates.length });
      const cursor = Number((await tx.query('SELECT max(sync_cursor) AS c FROM client_service WHERE client_id = $1', [clientId])).rows[0].c ?? 0);
      return { already: false, conversion: conversion as Record<string, unknown>, cursor };
    });
    if (res.cursor) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: res.cursor });
    const conv = res.conversion as { clientId: string; contactId: string | null; letterDocumentId: string | null; esignRequestId: string | null; portal: unknown };
    // Follow-ups outside the conversion transaction; each is recorded on the proposal so retries resume, never repeat.
    if (!conv.letterDocumentId) {
      const pdf = await this.letterPdf(a, id);
      conv.letterDocumentId = (await this.docs.upload(a, { buffer: pdf.buffer, mimetype: 'application/pdf', originalname: pdf.name, size: pdf.buffer.length },
        { clientId: conv.clientId, category: 'Engagement letters', fy: fyOf(today), tags: ['engagement-letter'], clientVisible: true }, null)).id;
      await this.saveConversion(a, id, conv);
    }
    if (b.sendForEsign && !conv.esignRequestId && conv.contactId) {
      conv.esignRequestId = (await this.esign.create(a, { title: 'Engagement letter', mode: 'parallel', items: [{ documentId: conv.letterDocumentId!, signers: [{ kind: 'contact', contactId: conv.contactId }] }] })).id;
      await this.saveConversion(a, id, conv);
    }
    if (b.inviteToPortal && !conv.portal && conv.contactId) {
      conv.portal = await this.portal.invite(a, { clientId: conv.clientId, contactId: conv.contactId, grants: b.portalGrants });
      await this.saveConversion(a, id, conv);
    }
    return { alreadyConverted: res.already, ...conv };
  }

  private saveConversion(a: RequestActor, id: string, conv: Record<string, unknown>) {
    return this.db.tenantTx(a.tenantId, (tx) => tx.query('UPDATE proposal SET conversion = $2 WHERE id = $1', [id, JSON.stringify(conv)]));
  }

  /** Engagement letter from the firm's template (placeholders rendered as plain text) → A4 PDF. */
  private async letterPdf(a: RequestActor, id: string): Promise<{ name: string; buffer: Buffer }> {
    const d = await this.db.tenantTx(a.tenantId, async (tx) => {
      const p = (await tx.query('SELECT * FROM proposal WHERE id = $1', [id])).rows[0];
      const v = (await tx.query('SELECT * FROM proposal_version WHERE proposal_id = $1 AND version = $2', [id, p.accepted_version])).rows[0];
      const c = (await tx.query('SELECT name FROM client WHERE id = $1', [p.conversion.clientId])).rows[0];
      const ct = p.conversion.contactId ? (await tx.query('SELECT name FROM contact WHERE id = $1', [p.conversion.contactId])).rows[0] : null;
      const e = p.entity_id ? (await tx.query('SELECT name FROM firm_entity WHERE id = $1', [p.entity_id])).rows[0] : null;
      const t = (await tx.query('SELECT name FROM tenant WHERE id = current_tenant()')).rows[0];
      return { p, v, client: c.name as string, contact: (ct?.name as string) ?? c.name, firm: (e?.name as string) ?? t.name, tpl: (await this.leads.settingsTx(tx)).engagementLetterTemplate };
    });
    const FREQ: Record<ProposalFrequency, string> = { one_time: 'one-time', monthly: 'per month', quarterly: 'per quarter', annual: 'per year' };
    const lines = d.v.lines as ProposalLine[];
    const vars = {
      'client.name': d.client, 'contact.name': d.contact, 'firm.name': d.firm, date: this.clock.todayIst(), 'proposal.number': `${d.p.number} v${d.p.accepted_version}`, valid_until: ymd(d.v.valid_until) ?? '-',
      services: lines.map((l) => `- ${l.description} (${FREQ[l.frequency]}): ${formatINR(Math.round(l.qty * l.feePaise) - (l.discountPaise ?? 0))} + GST ${l.gstRate}%`).join('\n'),
      fees: `${formatINR(n((d.v.totals as { firstYear: { taxablePaise: number } }).firstYear.taxablePaise))} for the first year (excluding GST)`, terms: d.v.terms ?? '-',
    };
    // renderTemplate trims values to 500 chars per placeholder: services/terms are long, so substitute those two directly (plain text, no markup).
    let body = d.tpl.replace(/\{\{\s*services\s*\}\}/g, vars.services).replace(/\{\{\s*terms\s*\}\}/g, vars.terms);
    body = renderTemplate(body, vars).text;
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((r) => doc.on('end', () => r()));
    doc.fontSize(16).text('Engagement Letter', { align: 'center' }).moveDown();
    doc.fontSize(10.5).text(body.replace(/₹/g, 'Rs. ').replace(/[^\x20-\x7e\n]/g, ''), { lineGap: 3 }); // standard PDF fonts: Latin-1 only
    doc.end();
    await done;
    return { name: `Engagement letter ${d.p.number} - ${d.client}.pdf`.replace(/[\\/:*?"<>|]/g, '-').slice(0, 250), buffer: Buffer.concat(chunks) };
  }
}

function fyOf(isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number) as [number, number];
  const s = m >= 4 ? y : y - 1;
  return `${s}-${String((s + 1) % 100).padStart(2, '0')}`;
}
