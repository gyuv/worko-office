import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate } from '@worko/i18n';
import { Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field, Tabs } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { multipart, todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan, useMe } from '../../lib/me';
import { useRoute } from '../../lib/router';
import { api, unwrap } from '../../lib/session';
import { paiseToInput, parseRupees } from '../billing/logic';
import { Money, RupeeInput } from '../billing/shared';
import { StatusPill, useP6Error } from '../time/shared';
import { as, body, useCategories, type Advance, type Claim, type ClaimDetail } from './api';
import { approvalSums, policyWarning } from './logic';

type View = 'claims' | 'approvals' | 'advances' | 'payouts';

export function ExpensesScreen() {
  const t = useT();
  const can = useCan();
  const params = useRoute((s) => s.params);
  const go = useRoute((s) => s.go);
  if (!can('hr', 'view')) return <p className="card p-6 text-muted">{t('p6.noAccess')}</p>;
  const tabs: Array<[View, string]> = [['claims', t('p6.exp.claims')], ['approvals', t('p6.exp.approvals')], ['advances', t('p6.exp.advances')],
    ...(can('hr', 'approve') ? [['payouts', t('p6.exp.payouts')] as [View, string]] : [])];
  const view = tabs.find(([k]) => k === params[0])?.[0] ?? 'claims';
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">{t('p6.nav.expenses')}</h1>
      <Tabs label={t('p6.nav.expenses')} tabs={tabs} value={view} onChange={(v) => go(`expenses/${v}`)} />
      {view === 'claims' && <MyClaims />}
      {view === 'approvals' && <ClaimApprovals />}
      {view === 'advances' && <Advances />}
      {view === 'payouts' && <Payouts />}
    </div>
  );
}

const useClaims = (query: { userId?: string; status?: string }, enabled = true) =>
  useQuery({ queryKey: ['hr', 'claims', query], enabled, queryFn: () => as<Claim[]>(api.GET('/hr/expenses/claims', { params: { query } })) });
const refreshHr = (qc: ReturnType<typeof useQueryClient>) => void qc.invalidateQueries({ queryKey: ['hr'] });

function MyClaims() {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const me = useMe().data;
  const list = useClaims({ userId: me?.id }, !!me);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: (id: string) => as(api.POST('/hr/expenses/claims/{id}/submit', { params: { path: { id } } })),
    onSuccess: () => toast({ text: t('p6.exp.submitted'), tone: 'ok' }, 3000), onError: (e) => toast({ text: err(e), tone: 'error' }), onSettled: () => refreshHr(qc),
  });
  return (
    <div className="space-y-2">
      <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={14} aria-hidden /> {t('p6.exp.newClaim')}</button>
      <ClaimTable items={list.data ?? []} onOpen={setOpen} action={(c) => c.status === 'draft' && <button className="btn" onClick={() => submit.mutate(c.id)}>{t('p6.submit')}</button>} />
      {creating && <ClaimDialog onClose={() => setCreating(false)} />}
      {open && <ClaimView id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ClaimTable({ items, onOpen, action, showPerson }: { items: Claim[]; onOpen(id: string): void; action?(c: Claim): ReactNode; showPerson?: boolean }) {
  const t = useT();
  if (!items.length) return <p className="card p-6 text-muted">{t('p6.exp.none')}</p>;
  return (
    <div className="card overflow-auto"><table className="table w-full">
      <thead><tr>{showPerson && <th>{t('p6.f.person')}</th>}<th>{t('p6.exp.title')}</th><th>{t('p6.f.status')}</th><th className="text-right">{t('p6.exp.claimed')}</th><th className="text-right">{t('p6.exp.approved')}</th><th className="text-right">{t('p6.exp.paid')}</th><th /></tr></thead>
      <tbody>{items.map((c) => (
        <tr key={c.id}>{showPerson && <td>{c.userName}</td>}<td><button className="underline" onClick={() => onOpen(c.id)}>{c.title}</button></td><td><StatusPill status={c.status} /></td>
          <td className="text-right"><Money p={c.claimedPaise} /></td><td className="text-right"><Money p={c.approvedPaise} /></td><td className="text-right"><Money p={c.paidPaise + c.advanceSettledPaise || null} /></td>
          <td className="text-right">{action?.(c)}</td></tr>
      ))}</tbody>
    </table></div>
  );
}

type LineDraft = { categoryKey: string; spentOn: string; description: string; amount: string; client: PickedClient | null; billable: boolean; receiptDocId: string | null; uploading?: boolean };
const blank = (cat = ''): LineDraft => ({ categoryKey: cat, spentOn: todayIst(), description: '', amount: '', client: null, billable: false, receiptDocId: null });

function ClaimDialog({ onClose }: { onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const cats = (useCategories().data ?? []).filter((c) => c.active);
  const [title, setTitle] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([blank()]);
  const set = (i: number, p: Partial<LineDraft>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...p } : l)));
  const catOf = (l: LineDraft) => cats.find((c) => c.key === (l.categoryKey || cats[0]?.key));
  const upload = async (i: number, file: File, client: PickedClient | null) => {
    set(i, { uploading: true });
    try {
      const r = await unwrap(api.POST('/documents', { body: multipart({ file, clientId: client?.id, category: t('p6.exp.receiptCategory') }) })) as { id: string };
      set(i, { receiptDocId: r.id, uploading: false });
    } catch (e) { set(i, { uploading: false }); toast({ text: err(e), tone: 'error' }); }
  };
  const total = lines.reduce((s, l) => s + (parseRupees(l.amount) ?? 0), 0);
  const invalid = !title.trim() || lines.some((l) => !l.description.trim() || !(parseRupees(l.amount)! > 0) || (l.billable && !l.client) || policyWarning(parseRupees(l.amount), catOf(l)) === 'block');
  const save = useMutation({
    mutationFn: (submit: boolean) => as<{ id: string; warnings: string[] }>(api.POST('/hr/expenses/claims', { body: body({ title: title.trim(), submit,
      lines: lines.map((l) => ({ categoryKey: catOf(l)!.key, spentOn: l.spentOn, description: l.description.trim(), amountPaise: parseRupees(l.amount)!, clientId: l.client?.id ?? null, billable: l.billable, receiptDocId: l.receiptDocId })) }) })),
    onSuccess: (r) => { refreshHr(qc); toast({ text: r.warnings?.length ? t('p6.exp.savedWarn', { count: r.warnings.length }) : t('p6.exp.saved'), tone: r.warnings?.length ? 'error' : 'ok' }, 5000); onClose(); },
    onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog wide title={t('p6.exp.newClaim')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!invalid) save.mutate(false); }}>
        <Field label={t('p6.exp.title')}><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required /></Field>
        {lines.map((l, i) => {
          const pw = policyWarning(parseRupees(l.amount), catOf(l));
          return (
            <fieldset key={i} className="space-y-2 rounded border border-border p-2">
              <legend className="px-1 text-xs text-muted">{t('p6.exp.line', { n: i + 1 })}</legend>
              <div className="grid gap-2 sm:grid-cols-4">
                <Field label={t('p6.exp.category')}><select className="input" value={catOf(l)?.key ?? ''} onChange={(e) => set(i, { categoryKey: e.target.value })}>
                  {cats.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</select></Field>
                <Field label={t('p6.f.date')}><input type="date" className="input" max={todayIst()} value={l.spentOn} onChange={(e) => set(i, { spentOn: e.target.value })} /></Field>
                <Field label={t('p6.exp.amount')} error={pw === 'block' ? t('p6.exp.overLimitBlock', { limit: paiseToInput(catOf(l)?.limitPaise) }) : null}
                  hint={pw === 'warn' ? <span className="text-due-soon">{t('p6.exp.overLimitWarn', { limit: paiseToInput(catOf(l)?.limitPaise) })}</span> : null}>
                  <RupeeInput label={t('p6.exp.amountOf', { n: i + 1 })} value={l.amount} onChange={(v) => set(i, { amount: v })} /></Field>
                <Field label={t('p6.exp.description')}><input className="input" aria-label={t('p6.exp.descriptionOf', { n: i + 1 })} value={l.description} onChange={(e) => set(i, { description: e.target.value })} /></Field>
              </div>
              <div className="grid items-end gap-2 sm:grid-cols-3">
                <ClientPicker label={t('p6.f.client')} value={l.client} onChange={(c) => set(i, { client: c, billable: c ? l.billable : false })} />
                <label className="flex items-center gap-2"><input type="checkbox" disabled={!l.client} checked={l.billable} onChange={(e) => set(i, { billable: e.target.checked })} /> {t('p6.exp.billable')}</label>
                <label className="block"><span className="label">{t('p6.exp.receipt')}</span>
                  <input type="file" accept="image/*,application/pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(i, f, l.client); }} />
                  <span className="text-xs text-muted">{l.uploading ? t('common.loading') : l.receiptDocId ? t('p6.exp.attached') : ''}</span></label>
              </div>
              {lines.length > 1 && <button type="button" className="btn" onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}><Trash2 size={14} aria-hidden /> {t('p6.exp.removeLine')}</button>}
            </fieldset>
          );
        })}
        <div className="flex items-center gap-2">
          <button type="button" className="btn" onClick={() => setLines((ls) => [...ls, blank(ls[ls.length - 1]?.categoryKey)])}><Plus size={14} aria-hidden /> {t('p6.exp.addLine')}</button>
          <span className="ml-auto">{t('p6.total')} <Money p={total} /></span>
        </div>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn" disabled={invalid || save.isPending}>{t('p6.exp.saveDraft')}</button>
          <button type="button" className="btn btn-primary" disabled={invalid || save.isPending} onClick={() => save.mutate(true)}>{t('p6.submit')}</button></div>
      </form>
    </Dialog>
  );
}

function useClaim(id: string) {
  return useQuery({ queryKey: ['hr', 'claim', id], queryFn: () => as<ClaimDetail>(api.GET('/hr/expenses/claims/{id}', { params: { path: { id } } })) });
}

function ClaimView({ id, onClose }: { id: string; onClose(): void }) {
  const t = useT();
  const cats = useCategories().data ?? [];
  const c = useClaim(id).data;
  return (
    <Dialog wide title={c?.title ?? t('common.loading')} onClose={onClose}>
      {c && <div className="space-y-2">
        <p><StatusPill status={c.status} /> {c.decisionNote && <span className="text-sm text-muted">{c.decisionNote}</span>}</p>
        <LinesTable lines={c.lines} cats={cats} />
        {c.payoutRef && <p className="text-sm">{t('p6.exp.paidRef', { ref: c.payoutRef })} · {t('p6.exp.advanceSettled')} <Money p={c.advanceSettledPaise} /></p>}
      </div>}
    </Dialog>
  );
}

function LinesTable({ lines, cats, approved, onApproved }: { lines: ClaimDetail['lines']; cats: Array<{ key: string; name: string }>; approved?: Record<string, string>; onApproved?(id: string, v: string): void }) {
  const t = useT();
  return (
    <div className="overflow-auto"><table className="table w-full">
      <thead><tr><th>{t('p6.f.date')}</th><th>{t('p6.exp.category')}</th><th>{t('p6.exp.description')}</th><th className="text-right">{t('p6.exp.claimed')}</th><th className="text-right">{t('p6.exp.approved')}</th></tr></thead>
      <tbody>{lines.map((l) => (
        <tr key={l.id}><td>{formatDate(l.spentOn)}</td><td>{cats.find((c) => c.key === l.categoryKey)?.name ?? l.categoryKey}</td>
          <td>{l.description}{l.billable && <span className="ml-1 text-xs text-primary">{t('p6.exp.billable')}</span>}{l.policyFlag && <span className="ml-1 text-xs text-due-soon">{t('p6.exp.policyFlag')}</span>}
            {l.receiptDocId && <span className="ml-1 text-xs text-muted">{t('p6.exp.attached')}</span>}</td>
          <td className="text-right"><Money p={l.amountPaise} /></td>
          <td className="text-right">{onApproved ? <RupeeInput label={t('p6.exp.approvedFor', { what: l.description })} value={approved?.[l.id] ?? paiseToInput(l.amountPaise)} onChange={(v) => onApproved(l.id, v)} /> : <Money p={l.approvedPaise} />}</td></tr>
      ))}</tbody>
    </table></div>
  );
}

function ClaimApprovals() {
  const me = useMe().data;
  const list = useClaims({ status: 'submitted' });
  const [open, setOpen] = useState<string | null>(null);
  const t = useT();
  return (
    <div className="space-y-2">
      <ClaimTable showPerson items={list.data ?? []} onOpen={setOpen}
        action={(c) => c.userId === me?.id ? <span className="text-xs text-muted">{t('p6.selfNotApprovable')}</span> : <button className="btn" onClick={() => setOpen(c.id)}>{t('p6.decide')}</button>} />
      {open && <DecideClaim id={open} own={(list.data ?? []).find((c) => c.id === open)?.userId === me?.id} onClose={() => setOpen(null)} />}
    </div>
  );
}

function DecideClaim({ id, own, onClose }: { id: string; own: boolean; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const cats = useCategories().data ?? [];
  const c = useClaim(id).data;
  const [approved, setApproved] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const sums = approvalSums(c?.lines ?? [], Object.fromEntries(Object.entries(approved).map(([k, v]) => [k, parseRupees(v)])));
  const m = useMutation({
    mutationFn: (approve: boolean) => as<{ status: string; approvedPaise: number }>(api.POST('/hr/expenses/claims/{id}/decide', { params: { path: { id } },
      body: body(approve ? { approve, lines: sums.lines, note: note.trim() || null } : { approve, note: note.trim() || null }) })),
    onSuccess: () => { refreshHr(qc); onClose(); }, onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog wide title={c ? t('p6.exp.decideTitle', { title: c.title, who: c.userName ?? '' }) : t('common.loading')} onClose={onClose}>
      {c && <div className="space-y-3">
        <LinesTable lines={c.lines} cats={cats} approved={approved} onApproved={own ? undefined : (k, v) => setApproved((a) => ({ ...a, [k]: v }))} />
        <p role="status" className="text-sm" data-testid="claim-sums">{t('p6.exp.sums')} <Money p={sums.approvedPaise} /> / <Money p={sums.claimedPaise} />{sums.partial && <span className="ml-2 text-due-soon">{t('p6.status.partially_approved')}</span>}</p>
        {sums.invalid.length > 0 && <p role="alert" className="text-sm text-overdue">{t('p6.exp.approvedTooHigh')}</p>}
        <Field label={t('p6.f.note')}><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-danger" disabled={own || m.isPending} onClick={() => m.mutate(false)}>{t('p6.reject')}</button>
          <button className="btn btn-primary" disabled={own || sums.invalid.length > 0 || m.isPending} onClick={() => m.mutate(true)}>{t('p6.approve')}</button></div>
      </div>}
    </Dialog>
  );
}

function Advances() {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const can = useCan();
  const me = useMe().data;
  const q = useQuery({ queryKey: ['hr', 'advances'], queryFn: () => as<{ items: Advance[]; outstandingPaise: number }>(api.GET('/hr/expenses/advances')) });
  const [req, setReq] = useState(false);
  const [deciding, setDeciding] = useState<Advance | null>(null);
  const [paying, setPaying] = useState<Advance | null>(null);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2"><button className="btn btn-primary" onClick={() => setReq(true)}><Plus size={14} aria-hidden /> {t('p6.exp.requestAdvance')}</button>
        <span className="ml-auto text-sm text-muted">{t('p6.exp.outstanding')} <Money p={q.data?.outstandingPaise ?? 0} /></span></div>
      <div className="card overflow-auto"><table className="table w-full" aria-label={t('p6.exp.advances')}>
        <thead><tr><th>{t('p6.f.person')}</th><th>{t('p6.exp.purpose')}</th><th className="text-right">{t('p6.exp.requested')}</th><th className="text-right">{t('p6.exp.approved')}</th><th className="text-right">{t('p6.exp.balance')}</th><th>{t('p6.f.status')}</th><th /></tr></thead>
        <tbody>{(q.data?.items ?? []).map((a) => (
          <tr key={a.id}><td>{a.userName}</td><td>{a.purpose}</td><td className="text-right"><Money p={a.amountPaise} /></td><td className="text-right"><Money p={a.approvedPaise} /></td><td className="text-right"><Money p={a.balancePaise} /></td>
            <td><StatusPill status={a.status} /></td>
            <td className="text-right">{a.userId !== me?.id && a.status === 'requested' && <button className="btn" onClick={() => setDeciding(a)}>{t('p6.decide')}</button>}
              {a.userId !== me?.id && a.status === 'approved' && can('hr', 'approve') && <button className="btn" onClick={() => setPaying(a)}>{t('p6.exp.markPaid')}</button>}</td></tr>
        ))}</tbody>
      </table></div>
      {req && <AdvanceDialog onClose={() => setReq(false)} />}
      {deciding && <DecideAdvance a={deciding} onClose={() => setDeciding(null)} />}
      {paying && <PayDialog title={t('p6.exp.payAdvance', { who: paying.userName ?? '' })} amount={paying.approvedPaise ?? paying.amountPaise} onClose={() => setPaying(null)}
        pay={(reference) => as(api.POST('/hr/expenses/advances/{id}/pay', { params: { path: { id: paying.id } }, body: { reference } }))} onDone={() => refreshHr(qc)} onError={(e) => toast({ text: err(e), tone: 'error' })} />}
    </div>
  );
}

function AdvanceDialog({ onClose }: { onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const [purpose, setPurpose] = useState('');
  const [amount, setAmount] = useState('');
  const p = parseRupees(amount);
  const m = useMutation({
    mutationFn: () => as(api.POST('/hr/expenses/advances', { body: { purpose: purpose.trim(), amountPaise: p! } })),
    onSuccess: () => { refreshHr(qc); onClose(); }, onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  return (
    <Dialog title={t('p6.exp.requestAdvance')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label={t('p6.exp.purpose')}><input className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)} required minLength={3} /></Field>
        <Field label={t('p6.exp.amount')}><RupeeInput label={t('p6.exp.amount')} value={amount} onChange={setAmount} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!(p! > 0) || purpose.trim().length < 3 || m.isPending}>{t('p6.request')}</button></div>
      </form>
    </Dialog>
  );
}

function DecideAdvance({ a, onClose }: { a: Advance; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const [amount, setAmount] = useState(paiseToInput(a.amountPaise));
  const p = parseRupees(amount);
  const m = useMutation({
    mutationFn: (approve: boolean) => as(api.POST('/hr/expenses/advances/{id}/decide', { params: { path: { id: a.id } }, body: approve ? { approve, approvedPaise: p! } : { approve } })),
    onSuccess: () => { refreshHr(qc); onClose(); }, onError: (e) => toast({ text: err(e), tone: 'error' }),
  });
  const bad = p === null || p <= 0 || p > a.amountPaise;
  return (
    <Dialog title={t('p6.exp.decideAdvance', { who: a.userName ?? '' })} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm">{a.purpose} · <Money p={a.amountPaise} /></p>
        <Field label={t('p6.exp.approvedAmount')} error={bad ? t('p6.exp.approvedTooHigh') : null}><RupeeInput label={t('p6.exp.approvedAmount')} value={amount} onChange={setAmount} /></Field>
        <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-danger" disabled={m.isPending} onClick={() => m.mutate(false)}>{t('p6.reject')}</button>
          <button className="btn btn-primary" disabled={bad || m.isPending} onClick={() => m.mutate(true)}>{t('p6.approve')}</button></div>
      </div>
    </Dialog>
  );
}

function PayDialog({ title, amount, pay, onClose, onDone, onError }: { title: string; amount: number; pay(ref: string): Promise<unknown>; onClose(): void; onDone(r: unknown): void; onError(e: unknown): void }) {
  const t = useT();
  const [ref, setRef] = useState('');
  const m = useMutation({ mutationFn: () => pay(ref.trim()), onSuccess: (r) => { onDone(r); onClose(); }, onError });
  return (
    <Dialog title={title} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <p><Money p={amount} /></p>
        <Field label={t('p6.exp.payRef')}><input className="input" value={ref} onChange={(e) => setRef(e.target.value)} required /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={!ref.trim() || m.isPending}>{t('p6.exp.markPaid')}</button></div>
      </form>
    </Dialog>
  );
}

function Payouts() {
  const t = useT();
  const qc = useQueryClient();
  const err = useP6Error();
  const me = useMe().data;
  const a = useClaims({ status: 'approved' });
  const p = useClaims({ status: 'partially_approved' });
  const items = [...(a.data ?? []), ...(p.data ?? [])];
  const [open, setOpen] = useState<string | null>(null);
  const [paying, setPaying] = useState<Claim | null>(null);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">{t('p6.exp.payoutHint')}</p>
      <ClaimTable showPerson items={items} onOpen={setOpen} action={(c) => c.userId !== me?.id && <button className="btn" onClick={() => setPaying(c)}>{t('p6.exp.markPaid')}</button>} />
      {open && <ClaimView id={open} onClose={() => setOpen(null)} />}
      {paying && <PayDialog title={t('p6.exp.payClaim', { title: paying.title })} amount={paying.approvedPaise ?? 0} onClose={() => setPaying(null)}
        pay={(reference) => as<{ advanceSettledPaise: number; paidPaise: number }>(api.POST('/hr/expenses/claims/{id}/pay', { params: { path: { id: paying.id } }, body: { reference } }))}
        onDone={(r) => { refreshHr(qc); const x = r as { advanceSettledPaise: number; paidPaise: number }; toast({ text: t('p6.exp.paidSplit', { settled: paiseToInput(x.advanceSettledPaise), paid: paiseToInput(x.paidPaise) }), tone: 'ok' }, 5000); }}
        onError={(e) => toast({ text: err(e), tone: 'error' })} />}
    </div>
  );
}
