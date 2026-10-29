import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  aiCostPaise, aiGate, aiSettingsSchema, can, classificationSchema, clientCtx, containsPii, dataBlock, draftSchema, estimateTokens, parseModelJson,
  rateForModel, redact, restore, summarySchema, UNTRUSTED_DATA_RULES, withinCap,
  type AiFeature, type AiRate, type AiSettings, type CommChannel, type FieldSuggestion, type Module, type RedactionMap, type SuggestionKind, type SuggestionSource,
} from '@worko/domain';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { clientScopeSql, Params, visibilityOf } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { CommService } from '../comm/comm.service.js';
import { istMonth } from '../comm/common.js';
import { KeyService } from '../crypto/key.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { DocumentsService } from '../documents/documents.service.js';
import { EsignService } from '../practice/esign.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { requireFirmWide } from '../tasks/system-actor.js';
import { AI_PROVIDER, envNoAi, type AiProvider } from './provider.js';

/** Module whose permission approving a suggestion needs (same as doing it by hand — D149). */
const KIND_MODULE: Record<SuggestionKind, Module> = { draft_reply: 'communication', draft_message: 'communication', summary: 'communication', classification: 'documents', esign_request: 'documents' };
const NOTICE_FIELDS = ['authority', 'section', 'din', 'referenceNo', 'assessmentYear', 'financialYear', 'issueDate', 'responseDue', 'demandPaise', 'pan', 'gstin'];

type Block = { label: string; id?: string; text: string };
type RunIn<T> = { tenantId: string; feature: AiFeature; userId: string | null; ruleId?: string | null; task: string; blocks: Block[]; schema: z.ZodType<T>; maxTokens?: number; extraNames?: string[] };
type RunOut<T> = { output: T | null; prompt: string; map: RedactionMap; provider: string; model: string; inputTokens: number; outputTokens: number; costPaise: number };
type Payload = Record<string, unknown> & { snippets?: Array<{ id: string; text: string }> };

/** Deep-restores placeholders in every string of a parsed model answer (server-side only). */
function restoreDeep<T>(v: T, map: RedactionMap): T {
  if (typeof v === 'string') return restore(v, map) as T;
  if (Array.isArray(v)) return v.map((x) => restoreDeep(x, map)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, restoreDeep(x, map)])) as T;
  return v;
}
const refuse = (code: string, message = 'AI is not available') => new ForbiddenException({ message, code });

/**
 * The AI layer (M21, D148–D152): gate (no-AI mode → opt-in → feature) → caps → redaction → delimited prompt → provider →
 * strict parse → restore → SUGGESTION record (encrypted) needing human approval → metering. Model output never triggers an
 * action; approval applies it through the normal service with the approver's own permissions. Phase 11's NL query reuses
 * `runModel` + `ask.ts`.
 */
@Injectable()
export class AiService {
  constructor(private db: DbService, private audit: AuditService, private keys: KeyService, private clock: Clock, private realtime: RealtimeService,
    @Inject(AI_PROVIDER) private provider: AiProvider, private comm: CommService, private docs: DocumentsService, private esign: EsignService) {}

  // ---------- Settings / usage ----------
  async settingsTx(tx: Tx): Promise<AiSettings> {
    const s = (await tx.query('SELECT settings FROM ai_settings LIMIT 1')).rows[0]?.settings;
    const p = aiSettingsSchema.safeParse(s ?? {});
    return p.success ? p.data : aiSettingsSchema.parse({});
  }
  /**
   * Settings as they apply to one feature. The Phase 8 toggle (`practice_settings.ai.noticeExtraction`, still on the web
   * settings screen) keeps counting as the opt-in for notice extraction only; no-AI mode still wins (D150).
   */
  private async effectiveTx(tx: Tx, feature: AiFeature): Promise<AiSettings> {
    const s = await this.settingsTx(tx);
    if (feature !== 'notice_extraction' || (s.enabled && s.features.notice_extraction)) return s;
    const legacy = (await tx.query(`SELECT (settings->'ai'->>'noticeExtraction')::boolean AS on FROM practice_settings LIMIT 1`)).rows[0]?.on === true;
    return legacy ? { ...s, enabled: true, features: { ...s.features, notice_extraction: true } } : s;
  }
  async getSettings(a: RequestActor) {
    const s = await this.db.tenantTx(a.tenantId, (tx) => this.settingsTx(tx));
    return { ...s, provider: this.provider.name, model: this.provider.model, external: this.provider.external, envNoAi: envNoAi() };
  }
  async putSettings(a: RequestActor, body: unknown) {
    requireFirmWide(a, 'settings', 'edit');
    const p = aiSettingsSchema.safeParse(body);
    if (!p.success) throw new BadRequestException({ message: 'Invalid settings', issues: p.error.issues });
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query(`INSERT INTO ai_settings (tenant_id, settings, updated_by) VALUES ($1,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET settings = $2, updated_by = $3, updated_at = now()`,
        [a.tenantId, JSON.stringify(p.data), a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'ai.settings_updated', entity: 'ai_settings', entityId: null, diff: p.data });
    });
    return this.getSettings(a);
  }
  /** Gate for a feature without calling anything (UI hints, automation dry-runs). */
  async gate(tenantId: string, feature: AiFeature) { return this.db.tenantTx(tenantId, async (tx) => aiGate(await this.effectiveTx(tx, feature), feature, envNoAi())); }

  async usage(a: RequestActor, month: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const s = await this.settingsTx(tx);
      const q = (by: string) => tx.query(`SELECT ${by} AS key, sum(input_tokens)::int AS "inputTokens", sum(output_tokens)::int AS "outputTokens", sum(cost_paise)::bigint AS "costPaise", count(*)::int AS calls
        FROM ai_usage WHERE month = $1 GROUP BY 1 ORDER BY 1`, [month]);
      const byFeature = (await q('feature')).rows; const byUser = (await q('user_id')).rows; const byRule = (await q('rule_id')).rows.filter((r) => r.key);
      const totalPaise = byFeature.reduce((n, r) => n + Number(r.costPaise), 0);
      const num = (rows: Array<Record<string, unknown>>) => rows.map((r) => ({ ...r, costPaise: Number(r.costPaise) }));
      return { month, provider: this.provider.name, totalPaise, capPaise: s.monthlyCapPaise, byFeature: num(byFeature), byUser: num(byUser), byRule: num(byRule) };
    });
  }

  private async rates(tx: Tx): Promise<AiRate[]> {
    return (await tx.query(`SELECT provider, model, input_paise_per_mtok AS "inputPaisePerMTok", output_paise_per_mtok AS "outputPaisePerMTok", to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom" FROM ai_rate`)).rows
      .map((r) => ({ ...r, inputPaisePerMTok: Number(r.inputPaisePerMTok), outputPaisePerMTok: Number(r.outputPaisePerMTok) }));
  }
  /** Cost estimate for a prompt of `chars` characters (dry-runs and cap pre-checks). */
  async estimatePaise(tx: Tx, chars: number, maxTokens = 1000) {
    const rate = rateForModel(await this.rates(tx), this.provider.name, this.provider.model, this.clock.todayIst());
    return aiCostPaise(rate, Math.ceil(chars / 4) + 300, maxTokens);
  }

  // ---------- Core call ----------
  /**
   * Gate → cap → redact (identifiers, contacts, client names) → hardened prompt → provider → strict parse → restore → meter.
   * Throws 403 with code no_ai_mode | ai_disabled | feature_disabled | ai_cap | redaction_failed.
   */
  async runModel<T>(i: RunIn<T>): Promise<RunOut<T>> {
    const now = this.clock.now(); const month = istMonth(now);
    const prep = await this.db.tenantTx(i.tenantId, async (tx) => {
      const s = await this.effectiveTx(tx, i.feature);
      const g = aiGate(s, i.feature, envNoAi());
      if (g !== 'ok') throw refuse(g);
      const all = i.blocks.map((b) => b.text).join('\n');
      const names = s.redactClientNames ? (await tx.query(`SELECT name FROM client WHERE deleted_at IS NULL AND length(name) >= 3 AND strpos(lower($1), lower(name)) > 0 LIMIT 500`, [all])).rows.map((r) => r.name as string) : [];
      let map: RedactionMap = {};
      const blocks = i.blocks.map((b) => { const r = redact(b.text.slice(0, 40_000), { names: [...names, ...(i.extraNames ?? [])], map }); map = r.map; return dataBlock(b.label, r.text, b.id); });
      const user = `${i.task}\n\n${blocks.join('\n\n')}`;
      if (containsPii(user)) throw refuse('redaction_failed', 'Could not redact the content safely');
      const system = `You assist an Indian CA/CS firm. ${UNTRUSTED_DATA_RULES} Reply with JSON only.`;
      const rates = await this.rates(tx);
      const rate = rateForModel(rates, this.provider.name, this.provider.model, this.clock.todayIst());
      const est = aiCostPaise(rate, estimateTokens(system + user), i.maxTokens ?? 1000);
      const used = Number((await tx.query('SELECT COALESCE(sum(cost_paise), 0)::bigint AS n FROM ai_usage WHERE month = $1', [month])).rows[0].n);
      if (!withinCap(used, est, s.monthlyCapPaise)) throw refuse('ai_cap', 'Monthly AI budget reached');
      if (i.userId && s.perUserMonthlyCapPaise !== null) {
        const mine = Number((await tx.query('SELECT COALESCE(sum(cost_paise), 0)::bigint AS n FROM ai_usage WHERE month = $1 AND user_id = $2', [month, i.userId])).rows[0].n);
        if (!withinCap(mine, est, s.perUserMonthlyCapPaise)) throw refuse('ai_cap', 'Your monthly AI budget is used up');
      }
      return { system, user, map, rate };
    });
    const res = await this.provider.complete({ feature: i.feature, system: prep.system, user: prep.user, maxTokens: i.maxTokens ?? 1000 });
    const costPaise = aiCostPaise(prep.rate, res.inputTokens, res.outputTokens);
    await this.db.tenantTx(i.tenantId, (tx) => tx.query(`INSERT INTO ai_usage (id, tenant_id, feature, user_id, rule_id, provider, model, input_tokens, output_tokens, cost_paise, month, occurred_at, device_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'server')`, [uuidv7(), i.tenantId, i.feature, i.userId, i.ruleId ?? null, this.provider.name, res.model, res.inputTokens, res.outputTokens, costPaise, month, now]));
    const parsed = res.refused ? null : parseModelJson(res.text, i.schema);
    return { output: parsed ? restoreDeep(parsed, prep.map) : null, prompt: prep.user, map: prep.map, provider: this.provider.name, model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costPaise };
  }

  // ---------- Features ----------
  /** (a) Notice extraction through the AI layer; suggestions still land in notice_extraction and need confirmation (D113). */
  async extractNotice(a: RequestActor, text: string): Promise<{ provider: string; suggestions: FieldSuggestion[] }> {
    // Loose envelope; each suggestion is checked against the field list below (anything else is dropped).
    const schema = z.object({ suggestions: z.array(z.any()).max(50).default([]) }) as unknown as z.ZodType<{ suggestions?: FieldSuggestion[] }>;
    const r = await this.runModel({ tenantId: a.tenantId, feature: 'notice_extraction', userId: a.userId, schema, maxTokens: 2000,
      task: `Extract fields from the Indian tax/regulatory notice below. Reply {"suggestions":[{"field":one of ${JSON.stringify(NOTICE_FIELDS)},"value":string|number,"confidence":0..1,"source":short quote}]}. Dates YYYY-MM-DD; demandPaise in paise. Omit fields you cannot find.`,
      blocks: [{ label: 'notice', text }] });
    const suggestions = (r.output?.suggestions ?? []).filter((s) => s && NOTICE_FIELDS.includes(s.field) && ['string', 'number'].includes(typeof s.value))
      .map((s) => ({ field: s.field, value: s.value, confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0)), source: String(s.source ?? '').slice(0, 120) }));
    return { provider: `ai:${r.provider}`, suggestions };
  }

  /** (b) Draft a reply to a client message or a notice. */
  async draftReply(a: RequestActor, b: { clientId: string; messageId?: string; noticeId?: string; channel: CommChannel; instruction?: string }) {
    const src = await this.db.tenantTx(a.tenantId, async (tx) => {
      const c = await this.clientFor(tx, a, b.clientId, 'communication', 'view');
      if (b.messageId) {
        const m = (await tx.query(`SELECT id, subject, body, channel FROM comm_message WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`, [b.messageId, c.id])).rows[0];
        if (!m) throw new NotFoundException();
        return { c, source: { type: 'comm_message' as const, id: m.id, label: `${m.channel} message` }, text: `${m.subject ?? ''}\n${m.body ?? ''}` };
      }
      if (b.noticeId) {
        const n = (await tx.query(`SELECT id, title, description, section, authority FROM notice WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`, [b.noticeId, c.id])).rows[0];
        if (!n || !can(a, 'notices', 'view', clientCtx(visibilityOf(c)))) throw new NotFoundException();
        return { c, source: { type: 'notice' as const, id: n.id, label: n.title }, text: `${n.authority} notice u/s ${n.section ?? '-'}: ${n.title}\n${n.description ?? ''}` };
      }
      throw new BadRequestException({ message: 'messageId or noticeId required', code: 'source_required' });
    });
    const r = await this.runModel({ tenantId: a.tenantId, feature: 'draft_reply', userId: a.userId, schema: draftSchema, extraNames: [src.c.name],
      task: `Draft a short, polite reply from the firm to the client about the item below${b.instruction ? `. Staff note: ${b.instruction.slice(0, 500)}` : ''}. Reply {"subject":string|null,"body":string}.`,
      blocks: [{ label: 'client', text: `Client: ${src.c.name}` }, { label: src.source.type, id: src.source.id, text: src.text }] });
    return this.saveSuggestion(a.tenantId, { kind: 'draft_reply', feature: 'draft_reply', clientId: src.c.id, entityType: src.source.type, entityId: src.source.id, requestedBy: a.userId, run: r,
      payload: r.output ? { ...r.output, channel: b.channel, snippets: [{ id: src.source.id, text: src.text.slice(0, 300) }] } : null,
      sources: [{ type: 'client', id: src.c.id, label: src.c.name }, src.source], meta: { channel: b.channel } }, a);
  }

  /** (c) Summarise a client's recent timeline (or one notice) for the 360 view. */
  async summarise(a: RequestActor, b: { clientId: string; noticeId?: string }) {
    const src = await this.db.tenantTx(a.tenantId, async (tx) => {
      const c = await this.clientFor(tx, a, b.clientId, 'communication', 'view');
      if (b.noticeId) {
        const n = (await tx.query(`SELECT id, title, description, section, authority, status, response_due FROM notice WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`, [b.noticeId, c.id])).rows[0];
        if (!n || !can(a, 'notices', 'view', clientCtx(visibilityOf(c)))) throw new NotFoundException();
        return { c, sources: [{ type: 'notice' as const, id: n.id as string, label: n.title as string, text: `${n.authority} ${n.section ?? ''} ${n.title} (${n.status}, reply due ${n.response_due ?? '-'})\n${n.description ?? ''}` }] };
      }
      const msgs = (await tx.query(`SELECT id, channel, direction, subject, body, occurred_at FROM comm_message WHERE client_id = $1 AND deleted_at IS NULL
        ORDER BY occurred_at DESC NULLS LAST LIMIT 30`, [c.id])).rows;
      return { c, sources: msgs.map((m) => ({ type: 'comm_message' as const, id: m.id as string, label: `${m.channel} ${m.direction}`, text: `${m.subject ?? ''} ${String(m.body ?? '').slice(0, 500)}`.trim() })) };
    });
    if (!src.sources.length) throw new ConflictException({ message: 'Nothing to summarise yet', code: 'nothing_to_summarise' });
    const r = await this.runModel({ tenantId: a.tenantId, feature: 'summarise', userId: a.userId, schema: summarySchema, extraNames: [src.c.name],
      task: 'Summarise the client history below for a partner in 3–5 sentences plus up to 5 key points (open asks, promises, risks). Reply {"summary":string,"points":[string]}.',
      blocks: [{ label: 'client', text: `Client: ${src.c.name}` }, ...src.sources.map((s) => ({ label: s.type, id: s.id, text: s.text }))] });
    return this.saveSuggestion(a.tenantId, { kind: 'summary', feature: 'summarise', clientId: src.c.id, entityType: b.noticeId ? 'notice' : 'client', entityId: b.noticeId ?? src.c.id, requestedBy: a.userId, run: r,
      payload: r.output ? { ...r.output, snippets: src.sources.slice(0, 10).map((s) => ({ id: s.id, text: s.text.slice(0, 200) })) } : null,
      sources: [{ type: 'client', id: src.c.id, label: src.c.name }, ...src.sources.map(({ text: _t, ...s }) => s)], meta: {} }, a);
  }

  /** (d) Category/FY suggestion for an upload (portal triage). */
  async classify(a: RequestActor, documentId: string, ruleId: string | null = null, runId: string | null = null) {
    const d = await this.db.tenantTx(a.tenantId, async (tx) => {
      const doc = (await tx.query('SELECT id, client_id, name, category, fy, extracted_text, mime FROM document WHERE id = $1 AND deleted_at IS NULL', [documentId])).rows[0];
      if (!doc?.client_id) throw new NotFoundException();
      const c = await this.clientFor(tx, a, doc.client_id, 'documents', 'view');
      return { doc, c };
    });
    const text = `File name: ${d.doc.name}\nType: ${d.doc.mime}\n${String(d.doc.extracted_text ?? '').slice(0, 5000)}`;
    const r = await this.runModel({ tenantId: a.tenantId, feature: ruleId ? 'automation_draft' : 'classify_upload', userId: ruleId ? null : a.userId, ruleId, schema: classificationSchema, extraNames: [d.c.name],
      task: 'Suggest a document category (short label, e.g. GST, Bank statements, Income tax, Sales invoices, General) and the Indian financial year (YYYY-YY) if evident. Reply {"category":string,"fy":string|null,"confidence":0..1}.',
      blocks: [{ label: 'document', id: d.doc.id, text }] });
    return this.saveSuggestion(a.tenantId, { kind: 'classification', feature: 'classify_upload', clientId: d.c.id, entityType: 'document', entityId: d.doc.id, requestedBy: ruleId ? null : a.userId, ruleId, runId, run: r,
      payload: r.output ? { ...r.output, current: { category: d.doc.category, fy: d.doc.fy }, snippets: [{ id: d.doc.id, text: text.slice(0, 200) }] } : null,
      sources: [{ type: 'document', id: d.doc.id, label: d.doc.name }], meta: {} }, a);
  }

  /** (e) Automation "AI draft message": a draft that waits for a human; never sent automatically. */
  async draftForAutomation(a: RequestActor, b: { clientId: string; channel: CommChannel; instruction: string; contextText: string; ruleId: string; runId: string }) {
    const c = await this.db.tenantTx(a.tenantId, (tx) => this.clientFor(tx, a, b.clientId, 'communication', 'view'));
    const r = await this.runModel({ tenantId: a.tenantId, feature: 'automation_draft', userId: null, ruleId: b.ruleId, schema: draftSchema, extraNames: [c.name],
      task: `Draft a short message from the firm to the client. Purpose: ${b.instruction.slice(0, 500)}. Reply {"subject":string|null,"body":string}.`,
      blocks: [{ label: 'client', text: `Client: ${c.name}` }, { label: 'context', text: b.contextText }] });
    return this.saveSuggestion(a.tenantId, { kind: 'draft_message', feature: 'automation_draft', clientId: c.id, entityType: 'client', entityId: c.id, requestedBy: null, ruleId: b.ruleId, runId: b.runId, run: r,
      payload: r.output ? { ...r.output, channel: b.channel } : null, sources: [{ type: 'client', id: c.id, label: c.name }, { type: 'rule', id: b.ruleId }], meta: { channel: b.channel } }, a);
  }

  /** Non-AI suggestion: an automation action that needs approval before it happens (e-sign requests — D143). */
  async proposeAction(a: RequestActor, b: { kind: 'esign_request'; clientId: string; entityType: string; entityId: string; payload: Payload; ruleId: string; runId: string; label: string }) {
    return this.saveSuggestion(a.tenantId, { kind: b.kind, feature: null, clientId: b.clientId, entityType: b.entityType, entityId: b.entityId, requestedBy: null, ruleId: b.ruleId, runId: b.runId, run: null,
      payload: b.payload, sources: [{ type: 'rule', id: b.ruleId }, { type: 'document', id: b.entityId, label: b.label }], meta: {} }, a);
  }

  private async saveSuggestion(tenantId: string, s: { kind: SuggestionKind; feature: AiFeature | null; clientId: string; entityType: string; entityId: string; requestedBy: string | null;
    ruleId?: string | null; runId?: string | null; run: RunOut<unknown> | null; payload: Payload | null; sources: SuggestionSource[]; meta: Record<string, unknown> }, a: RequestActor) {
    const id = uuidv7(); const now = this.clock.now();
    await this.db.tenantTx(tenantId, async (tx) => {
      const st = await this.settingsTx(tx);
      const enc = async (v: unknown, f: string) => (v == null ? null : this.keys.encrypt(tx, tenantId, typeof v === 'string' ? v : JSON.stringify(v), `suggestion:${id}:${f}`));
      const status = s.payload ? 'pending' : 'failed';
      const meta = { ...s.meta, ...(s.run ? { inputTokens: s.run.inputTokens, outputTokens: s.run.outputTokens, costPaise: s.run.costPaise } : {}) };
      await tx.query(`INSERT INTO suggestion (id, tenant_id, kind, feature, status, client_id, entity_type, entity_id, requested_by, rule_id, run_id, provider, model, payload_enc, prompt_enc, map_enc,
          sources, meta, error, purge_after, created_at, device_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'server')`,
        [id, tenantId, s.kind, s.feature, status, s.clientId, s.entityType, s.entityId, s.requestedBy, s.ruleId ?? null, s.runId ?? null, s.run?.provider ?? null, s.run?.model ?? null,
          await enc(s.payload, 'payload'), await enc(s.run?.prompt, 'prompt'), s.run && Object.keys(s.run.map).length ? await enc(s.run.map, 'map') : null,
          JSON.stringify(s.sources), JSON.stringify(meta), s.payload ? null : 'unusable_model_output', new Date(now.getTime() + st.retentionDays * 86_400_000), now]);
      // Metadata only: never the prompt, the output or the redaction map.
      await this.audit.record(tx, tenantId, { actorId: s.requestedBy, deviceId: a.deviceId, action: 'suggestion.created', entity: 'suggestion', entityId: id,
        diff: { kind: s.kind, feature: s.feature, status, clientId: s.clientId, entityType: s.entityType, entityId: s.entityId, ruleId: s.ruleId ?? null, provider: s.run?.provider ?? null, sources: s.sources.length } });
    });
    return this.db.tenantTx(tenantId, async (tx) => this.out(tx, tenantId, (await tx.query('SELECT * FROM suggestion WHERE id = $1', [id])).rows[0]));
  }

  // ---------- Suggestions: list / get / approve / reject ----------
  private async out(tx: Tx, tenantId: string, r: Record<string, unknown>) {
    const payload = r.payload_enc ? JSON.parse(await this.keys.decrypt(tx, tenantId, r.payload_enc as Buffer, `suggestion:${r.id}:payload`)) : null;
    return { id: r.id, kind: r.kind, feature: r.feature, status: r.status, clientId: r.client_id, entityType: r.entity_type, entityId: r.entity_id, requestedBy: r.requested_by,
      ruleId: r.rule_id, runId: r.run_id, provider: r.provider, model: r.model, mock: r.provider === 'mock', payload, sources: r.sources, meta: r.meta, decidedBy: r.decided_by, decidedAt: r.decided_at,
      applied: r.applied, error: r.error, purged: !!r.purged_at, createdAt: r.created_at };
  }
  private visibleSql(a: RequestActor, p: Params) {
    const kinds = (Object.keys(KIND_MODULE) as SuggestionKind[]).map((k) => `(s.kind = '${k}' AND ${clientScopeSql(a, KIND_MODULE[k], 'view', p)})`).join(' OR ');
    return `${clientScopeSql(a, 'clients', 'view', p)} AND (${kinds})`;
  }
  list(a: RequestActor, q: { status?: string; kind?: string; clientId?: string; limit: number }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params(); const w = [this.visibleSql(a, p)];
      if (q.status) w.push(`s.status = ${p.add(q.status)}`);
      if (q.kind) w.push(`s.kind = ${p.add(q.kind)}`);
      if (q.clientId) w.push(`s.client_id = ${p.add(q.clientId)}::uuid`);
      const rows = (await tx.query(`SELECT s.* FROM suggestion s JOIN client c ON c.id = s.client_id WHERE s.deleted_at IS NULL AND ${w.join(' AND ')} ORDER BY s.created_at DESC LIMIT ${p.add(q.limit)}`, p.values)).rows;
      const items = []; for (const r of rows) items.push(await this.out(tx, a.tenantId, r));
      return { items };
    });
  }
  private async load(tx: Tx, a: RequestActor, id: string, lock = false) {
    const p = new Params([id]);
    const r = (await tx.query(`SELECT s.* FROM suggestion s JOIN client c ON c.id = s.client_id WHERE s.id = $1 AND s.deleted_at IS NULL AND ${this.visibleSql(a, p)}${lock ? ' FOR UPDATE OF s' : ''}`, p.values)).rows[0];
    if (!r) throw new NotFoundException();
    return r;
  }
  get(a: RequestActor, id: string) { return this.db.tenantTx(a.tenantId, async (tx) => this.out(tx, a.tenantId, await this.load(tx, a, id))); }

  /**
   * Approval applies the suggestion through the normal service AS THE APPROVER (their permissions, consent/caps, audit):
   * messages via comm (edits allowed), summaries as a timeline note, classifications as document metadata, e-sign as a real request.
   */
  async approve(a: RequestActor, id: string, b: { subject?: string | null; body?: string; channel?: CommChannel; category?: string; fy?: string | null; note?: string }) {
    const s = await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await this.load(tx, a, id, true);
      if (r.status !== 'pending') throw new ConflictException({ message: 'Already decided', code: 'already_decided' });
      if (!r.payload_enc) throw new ConflictException({ message: 'Expired', code: 'expired' });
      const c = (await tx.query('SELECT * FROM client WHERE id = $1', [r.client_id])).rows[0];
      const mod = KIND_MODULE[r.kind as SuggestionKind];
      const action = r.kind === 'classification' || r.kind === 'esign_request' ? 'edit' : 'create';
      if (!can(a, mod, action, clientCtx(visibilityOf(c)))) throw new ForbiddenException({ message: `Needs ${mod}:${action}`, code: 'forbidden' });
      return this.out(tx, a.tenantId, r);
    });
    const p = s.payload as Record<string, unknown>;
    let applied: Record<string, unknown>;
    switch (s.kind) {
      case 'draft_reply': case 'draft_message': {
        const channel = (b.channel ?? p.channel ?? 'email') as CommChannel;
        const body = b.body ?? String(p.body ?? '');
        const r = await this.comm.send(a, { clientId: s.clientId as string, channel, subject: b.subject !== undefined ? b.subject : (p.subject as string | null) ?? 'Message from your CA', body });
        applied = { messageId: r.id, status: r.status, channel, edited: b.body !== undefined && b.body !== p.body };
        break;
      }
      case 'summary': {
        const r = await this.comm.logActivity(a, s.clientId as string, { channel: 'note', subject: 'Summary (AI suggestion, reviewed)', body: b.body ?? String(p.summary ?? '') });
        applied = { messageId: r.id };
        break;
      }
      case 'classification': {
        const category = b.category ?? String(p.category);
        const fy = b.fy !== undefined ? b.fy : (p.fy as string | null);
        await this.docs.updateMeta(a, s.entityId as string, { category, ...(fy ? { fy } : {}) });
        applied = { documentId: s.entityId, category, fy };
        break;
      }
      case 'esign_request': {
        const r = await this.esign.create(a, p as unknown as Parameters<EsignService['create']>[1]);
        applied = { esignRequestId: (r as { id: string }).id };
        break;
      }
      default: throw new BadRequestException('Unknown kind');
    }
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query(`UPDATE suggestion SET status = 'approved', decided_by = $2, decided_at = $3, applied = $4, version = version + 1, updated_by = $2 WHERE id = $1`, [id, a.userId, this.clock.now(), JSON.stringify(applied)]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'suggestion.approved', entity: 'suggestion', entityId: id,
        diff: { kind: s.kind, edited: !!(b.body !== undefined || b.category !== undefined || b.fy !== undefined), applied: Object.fromEntries(Object.entries(applied).filter(([k]) => k.endsWith('Id') || k === 'status' || k === 'channel')) } });
    });
    return { id, status: 'approved', applied };
  }

  async reject(a: RequestActor, id: string, reason?: string) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await this.load(tx, a, id, true);
      if (r.status !== 'pending') throw new ConflictException({ message: 'Already decided', code: 'already_decided' });
      await tx.query(`UPDATE suggestion SET status = 'rejected', decided_by = $2, decided_at = $3, version = version + 1, updated_by = $2 WHERE id = $1`, [id, a.userId, this.clock.now()]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'suggestion.rejected', entity: 'suggestion', entityId: id, diff: { kind: r.kind, reason: reason ? reason.slice(0, 200) : null } });
    });
  }

  /** Retention: drop encrypted prompt/output/map after `retentionDays`; metadata stays (D151). */
  async purgeExpired(tenantId: string, now: Date) {
    return this.db.tenantTx(tenantId, async (tx) => (await tx.query(`UPDATE suggestion SET prompt_enc = NULL, payload_enc = NULL, map_enc = NULL, purged_at = $1, version = version + 1
      WHERE purge_after <= $1 AND purged_at IS NULL`, [now])).rowCount ?? 0);
  }

  private async clientFor(tx: Tx, a: RequestActor, clientId: string, module: Module, action: 'view' | 'create' | 'edit') {
    const c = (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [clientId])).rows[0];
    const ctx = c && clientCtx(visibilityOf(c));
    if (!c || !can(a, 'clients', 'view', ctx) || !can(a, module, 'view', ctx)) throw new NotFoundException();
    if (!can(a, module, action, ctx)) throw new ForbiddenException();
    return c as Record<string, unknown> & { id: string; name: string };
  }
}
