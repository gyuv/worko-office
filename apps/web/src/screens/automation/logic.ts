import {
  ACTION_NEEDS, AUTOMATION_EVENTS, CONTEXT_FIELDS, conditionSchema, EVENT_PROVIDES, isScanEvent, nextRunAt, PERSONAL_ACTIONS, ruleDefinitionSchema, scopeErrors,
  type ActionType, type AutomationEvent, type Condition, type FieldType, type Leaf, type RuleDefinition, type RuleScope, type Schedule, type Section,
} from '@worko/domain';
import type { CONDITION_OPS } from '@worko/domain';
import { formatDateTime, type Translate } from '@worko/i18n';
import { parseRupees } from '../billing/logic';

/** Pure helpers for the Phase 10 automation screens (rule builder ↔ domain zod schemas, schedule text, dry-run grouping, diffs). */

export type Op = (typeof CONDITION_OPS)[number];
export type LeafNode = { id: string; kind: 'leaf'; field: string; op: Op; raw: string };
export type GroupNode = { id: string; kind: 'group'; mode: 'all' | 'any'; negate: boolean; children: Node[] };
export type Node = LeafNode | GroupNode;

let seq = 0;
export const nid = () => `n${++seq}`;

/** Amount fields are entered in rupees and stored as integer paise. */
export const isPaiseField = (f: string) => /Paise$/.test(f);
export const fieldType = (f: string): FieldType | undefined => CONTEXT_FIELDS[f];

/** Fields a trigger's context actually provides (event.* and entity.type always). */
export function fieldsFor(ev: AutomationEvent): string[] {
  const has = new Set<string>(EVENT_PROVIDES[ev]);
  return Object.keys(CONTEXT_FIELDS).filter((f) => {
    const s = f.split('.')[0]!;
    if (s === 'event') return f === 'event.type' || isScanEvent(ev);
    return s === 'entity' || has.has(s as Section);
  });
}

/** Operators that make sense for a field type (the schema rejects the rest anyway). */
export function opsFor(t: FieldType | undefined): Op[] {
  const base: Op[] = ['eq', 'neq', 'exists', 'not_exists'];
  if (t === 'number' || t === 'date') return [...base, 'gt', 'gte', 'lt', 'lte', 'in', 'nin'];
  if (t === 'boolean') return ['eq', 'neq', 'exists', 'not_exists'];
  if (t === 'string[]') return ['contains', 'exists', 'not_exists'];
  return [...base, 'in', 'nin', 'contains'];
}
export const needsValue = (op: Op) => op !== 'exists' && op !== 'not_exists';
export const isList = (op: Op) => op === 'in' || op === 'nin';

/** Raw text → typed value (rupees → paise for amount fields). Unparseable input is kept as text so the schema reports it. */
function parseScalar(field: string, raw: string): string | number | boolean {
  const t = fieldType(field);
  const s = raw.trim();
  if (t === 'number') {
    if (isPaiseField(field)) { const p = parseRupees(s); return p === null ? s : p; }
    return s !== '' && /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
  }
  if (t === 'boolean') return s === 'true' ? true : s === 'false' ? false : s;
  return s;
}
function formatScalar(field: string, v: unknown): string {
  if (typeof v === 'number' && isPaiseField(field)) return (v / 100).toFixed(2).replace(/\.00$/, '');
  return String(v);
}

export function leafToCondition(l: LeafNode): Leaf {
  if (!needsValue(l.op)) return { field: l.field, op: l.op };
  if (isList(l.op)) {
    const vals = l.raw.split(',').map((x) => x.trim()).filter(Boolean).map((x) => parseScalar(l.field, x));
    return { field: l.field, op: l.op, value: vals as Array<string | number> };
  }
  return { field: l.field, op: l.op, value: l.raw.trim() === '' ? undefined : parseScalar(l.field, l.raw) };
}

/** Builder tree → stored condition ({ all|any }, `not` for negated groups). */
export function toCondition(g: GroupNode): Condition {
  const kids = g.children.map((c) => (c.kind === 'leaf' ? leafToCondition(c) : toCondition(c)));
  const inner: Condition = g.mode === 'all' ? { all: kids } : { any: kids };
  return g.negate ? { not: inner } : inner;
}

/** Stored condition → builder tree (the root is always a group). */
export function fromCondition(c: Condition | undefined): GroupNode {
  const wrap = (x: Condition): Node => {
    if ('all' in x) return { id: nid(), kind: 'group', mode: 'all', negate: false, children: x.all.map(wrap) };
    if ('any' in x) return { id: nid(), kind: 'group', mode: 'any', negate: false, children: x.any.map(wrap) };
    if ('not' in x) {
      const n = wrap(x.not);
      return n.kind === 'group' && !n.negate ? { ...n, negate: true } : { id: nid(), kind: 'group', mode: 'all', negate: true, children: [n] };
    }
    const v = x.value;
    return { id: nid(), kind: 'leaf', field: x.field, op: x.op, raw: v === undefined ? '' : Array.isArray(v) ? v.map((y) => formatScalar(x.field, y)).join(', ') : formatScalar(x.field, v) };
  };
  const root = wrap(c ?? { all: [] });
  return root.kind === 'group' ? root : { id: nid(), kind: 'group', mode: 'all', negate: false, children: [root] };
}

/** Inline errors per leaf id: schema issues + "field not available for this trigger". */
export function leafErrors(g: GroupNode, ev: AutomationEvent): Record<string, string> {
  const ok = new Set(fieldsFor(ev));
  const out: Record<string, string> = {};
  const walk = (n: Node) => {
    if (n.kind === 'group') { n.children.forEach(walk); return; }
    if (!ok.has(n.field)) { out[n.id] = `field_unavailable`; return; }
    const r = conditionSchema.safeParse(leafToCondition(n));
    if (!r.success) out[n.id] = r.error.issues[0]?.message ?? 'Invalid';
  };
  walk(g);
  return out;
}

export function updateNode(g: GroupNode, id: string, f: (n: Node) => Node | null): GroupNode {
  const map = (n: Node): Node | null => {
    if (n.id === id) return f(n);
    if (n.kind === 'group') return { ...n, children: n.children.map(map).filter((x): x is Node => !!x) };
    return n;
  };
  return (map(g) as GroupNode | null) ?? { ...g, children: [] };
}

// ---------- Definition validation ----------
export type DefIssues = { form: string[]; actions: Record<number, string[]>; trigger: string[] };
export function validateDefinition(d: unknown, scope: RuleScope): { ok: true; def: RuleDefinition } | { ok: false; issues: DefIssues } {
  const issues: DefIssues = { form: [], actions: {}, trigger: [] };
  const r = ruleDefinitionSchema.safeParse(d);
  if (!r.success) {
    for (const i of r.error.issues) {
      const [head, idx] = i.path;
      const msg = i.path.length > 2 ? `${i.path.slice(2).join('.')}: ${i.message}` : i.message;
      if (head === 'actions' && typeof idx === 'number') (issues.actions[idx] ??= []).push(msg);
      else if (head === 'trigger') issues.trigger.push(`${i.path.slice(1).join('.')}: ${i.message}`);
      else issues.form.push(`${i.path.join('.') || 'rule'}: ${i.message}`);
    }
    return { ok: false, issues };
  }
  const se = scopeErrors(r.data, scope);
  if (se.length) { issues.form.push(...se); return { ok: false, issues }; }
  return { ok: true, def: r.data };
}

/** Actions offered for a trigger + scope (needs a context section the trigger provides; personal = internal only). */
export function actionsFor(ev: AutomationEvent, scope: RuleScope, all: readonly ActionType[]): ActionType[] {
  const has = new Set<string>(EVENT_PROVIDES[ev]);
  return all.filter((a) => (scope === 'firm' || PERSONAL_ACTIONS.includes(a)) && (!ACTION_NEEDS[a] || has.has(ACTION_NEEDS[a]!)));
}
export const EVENT_TRIGGERS = AUTOMATION_EVENTS.filter((e) => e !== 'schedule');

// ---------- Schedule text (IST) ----------
const pad = (n: number) => String(n).padStart(2, '0');
export function time12(at: string): string {
  const [h, m] = at.split(':').map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}
/** "Every Monday at 9:00 AM IST · next: 02 Nov 2026, 09:00 am" — always IST, whatever the device zone. */
export function scheduleText(s: Schedule, t: Translate, now = new Date()): string {
  const at = time12(s.at);
  const base = s.freq === 'daily' ? t('p10.sch.daily', { at })
    : s.freq === 'weekly' ? t('p10.sch.weekly', { day: t(`p10.wd.${s.weekday ?? 1}` as 'p10.wd.1'), at })
      : t('p10.sch.monthly', { day: s.monthDay ?? 1, at });
  try { return `${base} · ${t('p10.sch.next', { at: formatDateTime(nextRunAt(s, now)) })}`; } catch { return base; }
}

// ---------- Dry-run ----------
export type Plan = { type: string; summary: string; wouldRefuse: string | null; costPaise: number; details: Record<string, unknown> };
export type DryItem = { entity: { type: string; id: string }; clientId: string | null; clientName: string | null; step: string; skipped: string | null; matched: boolean;
  conditions: Array<{ field: string; op: string; ok: boolean; actual: unknown }>; actions: Plan[] };
export type DryRun = { trigger: string; asOf: string; evaluated: number; matched: number; actions: number; estimatedCostPaise: number; refusals: Record<string, number>;
  monthToDateCostPaise: number; capPaise: number; items: DryItem[] };

/** Splits a dry-run into what would happen, what is skipped (by reason) and what doesn't match; counts messages/refusals. */
export function groupDryRun(r: DryRun) {
  const matched = r.items.filter((i) => i.matched);
  const skipped: Record<string, DryItem[]> = {};
  for (const i of r.items) if (i.skipped) (skipped[i.skipped] ??= []).push(i);
  const unmatched = r.items.filter((i) => !i.matched && !i.skipped);
  const plans = matched.flatMap((i) => i.actions);
  const messages = plans.filter((p) => (p.type === 'send_message' || p.type === 'ai_draft_message') && !p.wouldRefuse).length;
  const refusals = Object.entries(r.refusals).sort((a, b) => b[1] - a[1]);
  const consentRefusals = refusals.filter(([c]) => ['opted_out', 'not_opted_in', 'no_address', 'quiet_hours'].includes(c)).reduce((n, [, k]) => n + k, 0);
  const overCap = r.capPaise > 0 && r.monthToDateCostPaise + r.estimatedCostPaise > r.capPaise;
  return { matched, skipped, unmatched, messages, refusals, consentRefusals, overCap, willDo: plans.filter((p) => !p.wouldRefuse).length };
}

// ---------- Runs ----------
export type RunAction = { idx: number; type: string; status: string; code: string | null; result: Record<string, unknown> | null; costPaise: number; error: string | null; attempts: number; finishedAt: string | null };
/** Business refusals are rules working (consent, caps, UDIN…); only failures are retryable. */
export const runActionTone = (s: string) => (s === 'done' || s === 'queued' ? 'ok' : s === 'refused' ? 'refused' : s === 'failed' ? 'failed' : 'muted');
export const canRetry = (actions: RunAction[]) => actions.some((a) => a.status === 'failed');
/** End of an IST day as an ISO instant (for the `before` filter). */
export const endOfIstDay = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00+05:30`) + 86_400_000).toISOString();

// ---------- Versions diff ----------
export type DiffLine = { op: ' ' | '+' | '-'; text: string };
/** Line diff (LCS) of two pretty-printed definitions. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split('\n'); const y = b.split('\n');
  const n = x.length; const m = y.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: DiffLine[] = []; let i = 0; let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: ' ', text: x[i]! }); i++; j++; }
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push({ op: '-', text: x[i++]! });
    else out.push({ op: '+', text: y[j++]! });
  }
  while (i < n) out.push({ op: '-', text: x[i++]! });
  while (j < m) out.push({ op: '+', text: y[j++]! });
  return out;
}
export const pretty = (d: unknown) => JSON.stringify(d, null, 2);

/** IST month `YYYY-MM`. */
export const istMonth = (now = new Date()) => new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 7);

// ---------- Agent params ----------
export type ParamKind = { kind: 'list' } | { kind: 'number' } | { kind: 'boolean' } | { kind: 'enum'; options: string[] } | { kind: 'text' };
/** Form control for an agent parameter, decided from its default value and name. */
export function paramKind(name: string, def: unknown, channels: readonly string[]): ParamKind {
  if (Array.isArray(def)) return { kind: 'list' };
  if (typeof def === 'number') return { kind: 'number' };
  if (typeof def === 'boolean') return { kind: 'boolean' };
  if (name === 'channel') return { kind: 'enum', options: [...channels] };
  if (name === 'kind') return { kind: 'enum', options: ['dsc', 'licence'] };
  return { kind: 'text' };
}
export function paramsFromRaw(raw: Record<string, string>, defaults: Record<string, unknown>, channels: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const pk = paramKind(k, defaults[k], channels);
    if (pk.kind === 'list') out[k] = v.split(',').map((s) => s.trim()).filter(Boolean);
    else if (pk.kind === 'number') out[k] = v.trim() === '' ? undefined : Number(v);
    else if (pk.kind === 'boolean') out[k] = v === 'true';
    else if (v.trim() !== '') out[k] = v.trim();
  }
  return out;
}
export const rawFromParams = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : String(v)]));
