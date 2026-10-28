import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Schemas } from '@worko/api-client';
import { ArrowLeft, Copy, FileDown, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ClientPicker, type PickedClient } from '../../components/ClientPicker';
import { Dialog, Field } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { errStatus, todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { useRoute } from '../../lib/router';
import { api, unwrap } from '../../lib/session';
import { allowedActions, paiseToInput, parseRupees, taxRows, type InvoiceAction } from './logic';
import { MockBadge, Money, openPdf, RupeeInput, StatusBadge, useBillingSettings, useEntities } from './shared';

type Detail = Schemas['InvoiceDetail'];
type LineIn = Schemas['InvoiceLineIn'];
export type LineDraft = { description: string; sac: string; serviceTypeId: string | null; qty: string; rate: string; discount: string; gstRate: string; reimbursement: boolean; taskIds: string[] };

const blankLine = (reimbursement = false): LineDraft => ({ description: '', sac: '', serviceTypeId: null, qty: '1', rate: '', discount: '', gstRate: '', reimbursement, taskIds: [] });

/** Validated request lines, or null when any amount is invalid. GST % left blank = the service/firm default on the server. */
export function toLinesIn(lines: LineDraft[]): LineIn[] | null {
  const out: LineIn[] = [];
  for (const l of lines) {
    const rate = parseRupees(l.rate); const disc = l.discount ? parseRupees(l.discount) : 0; const qty = Number(l.qty);
    if (!l.description.trim() || rate === null || disc === null || !Number.isFinite(qty) || qty <= 0) return null;
    const gst = l.gstRate.trim() === '' ? undefined : Number(l.gstRate);
    if (gst !== undefined && !Number.isFinite(gst)) return null;
    out.push({ description: l.description.trim(), sac: l.sac || null, serviceTypeId: l.serviceTypeId, qty, ratePaise: rate, discountPaise: disc, reimbursement: l.reimbursement, taskIds: l.taskIds,
      ...(gst !== undefined && !l.reimbursement ? { gstRate: gst } : {}) });
  }
  return out;
}

const fromDetail = (d: Detail): LineDraft[] => (d.lines ?? []).map((l) => ({
  description: l.description ?? '', sac: l.sac ?? '', serviceTypeId: l.serviceTypeId ?? null, qty: String(l.qty ?? 1), rate: paiseToInput(l.ratePaise),
  discount: l.discountPaise ? paiseToInput(l.discountPaise) : '', gstRate: l.gstRate !== undefined && l.gstRate !== null ? String(l.gstRate) : '', reimbursement: !!l.reimbursement, taskIds: l.taskIds ?? [],
}));

function useErr() {
  const t = useT();
  return (e: unknown) => toast({ text: (e as Error)?.message || t('common.error'), tone: 'error' });
}

export function NewInvoice() {
  const t = useT();
  const go = useRoute((s) => s.go);
  const qc = useQueryClient();
  const settings = useBillingSettings().data;
  const [client, setClient] = useState<PickedClient | null>(null);
  const [entityId, setEntityId] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);
  const err = useErr();
  const create = useMutation({
    mutationFn: () => {
      const ls = toLinesIn(lines);
      if (!ls || !client) throw new Error(t('bill.invalidLines'));
      return unwrap(api.POST('/billing/invoices', { body: { clientId: client.id, entityId: entityId || settings?.defaultEntityId || null, notes: notes || null, lines: ls } }));
    },
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['billing'] }); go(`billing/${(r as { id: string }).id}`); },
    onError: err,
  });
  return (
    <div className="space-y-3">
      <a href="#/billing" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} aria-hidden /> {t('nav.billing')}</a>
      <h1 className="text-xl font-semibold">{t('bill.newInvoice')}</h1>
      <form className="card space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <ClientPicker label={t('bill.client')} value={client} onChange={setClient} />
          <EntitySelect value={entityId || settings?.defaultEntityId || ''} onChange={setEntityId} />
        </div>
        <LinesEditor lines={lines} onChange={setLines} clientId={client?.id ?? null} />
        <Field label={t('bill.notes')}><textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <p className="text-xs text-muted">{t('bill.taxComputedServer')}</p>
        <button className="btn btn-primary" disabled={!client || create.isPending}>{t('bill.createDraft')}</button>
      </form>
    </div>
  );
}

function EntitySelect({ value, onChange, disabled }: { value: string; onChange(v: string): void; disabled?: boolean }) {
  const t = useT();
  const entities = (useEntities().data ?? []).filter((e) => e.active || e.id === value);
  return (
    <Field label={t('bill.entity')}>
      <select className="input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('bill.defaultEntity')}</option>
        {entities.map((e) => <option key={e.id} value={e.id}>{e.name}{e.gstin ? ` · ${e.gstin}` : ''}</option>)}
      </select>
    </Field>
  );
}

/** Line grid + reimbursement lines + "link unbilled tasks" picker. */
function LinesEditor({ lines, onChange, clientId }: { lines: LineDraft[]; onChange(l: LineDraft[]): void; clientId: string | null }) {
  const t = useT();
  const set = (i: number, p: Partial<LineDraft>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const linked = new Set(lines.flatMap((l) => l.taskIds));
  const unbilled = useQuery({ queryKey: ['billing', 'unbilled', { clientId }], enabled: !!clientId,
    queryFn: () => unwrap(api.GET('/billing/unbilled', { params: { query: { clientId: clientId! } } })) });
  const avail = (unbilled.data?.items ?? []).filter((u) => u.taskId && !linked.has(u.taskId));
  return (
    <div className="space-y-2">
      <div className="overflow-auto">
        <table className="table w-full">
          <thead><tr><th>{t('bill.line.description')}</th><th>{t('bill.line.sac')}</th><th>{t('bill.line.qty')}</th><th>{t('bill.line.rate')}</th><th>{t('bill.line.discount')}</th><th>{t('bill.line.gst')}</th><th><span className="sr-only">{t('docs.actions')}</span></th></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={i}>
              <td>
                <input className="input" aria-label={t('bill.line.descriptionN', { n: i + 1 })} required value={l.description} onChange={(e) => set(i, { description: e.target.value })} />
                {l.reimbursement && <span className="text-xs text-muted">{t('bill.line.reimbursementHint')}</span>}
                {l.taskIds.length > 0 && <span className="text-xs text-muted">{t('bill.line.tasks', { count: l.taskIds.length })}</span>}
              </td>
              <td><input className="input w-24 font-mono" aria-label={t('bill.line.sacN', { n: i + 1 })} disabled={l.reimbursement} value={l.sac} onChange={(e) => set(i, { sac: e.target.value })} /></td>
              <td><input className="input w-16 text-right" aria-label={t('bill.line.qtyN', { n: i + 1 })} inputMode="decimal" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} /></td>
              <td><RupeeInput label={t('bill.line.rateN', { n: i + 1 })} required value={l.rate} onChange={(v) => set(i, { rate: v })} /></td>
              <td><RupeeInput label={t('bill.line.discountN', { n: i + 1 })} value={l.discount} onChange={(v) => set(i, { discount: v })} /></td>
              <td><input className="input w-16 text-right" aria-label={t('bill.line.gstN', { n: i + 1 })} placeholder={t('bill.line.gstDefault')} disabled={l.reimbursement} inputMode="decimal" value={l.gstRate} onChange={(e) => set(i, { gstRate: e.target.value })} /></td>
              <td><button type="button" className="btn" aria-label={t('bill.line.remove', { n: i + 1 })} onClick={() => onChange(lines.filter((_, j) => j !== i))}><Trash2 size={14} /></button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" onClick={() => onChange([...lines, blankLine()])}><Plus size={14} aria-hidden /> {t('bill.line.add')}</button>
        <button type="button" className="btn" onClick={() => onChange([...lines, blankLine(true)])}><Plus size={14} aria-hidden /> {t('bill.line.addReimbursement')}</button>
      </div>
      {clientId && avail.length > 0 && (
        <details className="card p-2">
          <summary className="cursor-pointer text-sm">{t('bill.linkTasks', { count: avail.length })}</summary>
          <ul className="mt-2 space-y-1">{avail.map((u) => (
            <li key={u.taskId} className="flex items-center gap-2 text-sm">
              <span className="flex-1">{u.title} {u.periodKey && <span className="text-muted">· {u.periodKey}</span>}</span>
              <Money p={u.suggestedPaise ?? null} />
              <button type="button" className="btn" onClick={() => onChange([...lines.filter((l) => l.description || l.rate), {
                ...blankLine(), description: u.title ?? '', serviceTypeId: u.serviceTypeId ?? null, rate: paiseToInput(u.suggestedPaise ?? 0), taskIds: [u.taskId!] }])}>
                {t('bill.addTask')}</button>
            </li>
          ))}</ul>
        </details>
      )}
    </div>
  );
}

export function TaxSummary({ inv }: { inv: Parameters<typeof taxRows>[0] }) {
  const t = useT();
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm" aria-label={t('bill.taxSummary')}>
      {taxRows(inv).map((r) => (
        <div key={r.key} className={`contents ${r.key === 'total' ? 'font-semibold' : ''}`}>
          <dt>{t(`bill.tax.${r.key}`)}</dt><dd className="text-right" data-testid={`tax-${r.key}`}><Money p={r.paise} /></dd>
        </div>
      ))}
    </dl>
  );
}

export function InvoiceView({ id }: { id: string }) {
  const t = useT();
  const can = useCan();
  const go = useRoute((s) => s.go);
  const qc = useQueryClient();
  const err = useErr();
  const q = useQuery({ queryKey: ['billing', 'invoice', id], queryFn: () => unwrap(api.GET('/billing/invoices/{id}', { params: { path: { id } } })), retry: false });
  const [dialog, setDialog] = useState<InvoiceAction | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['billing'] }); };
  const del = useMutation({ mutationFn: () => unwrap(api.DELETE('/billing/invoices/{id}', { params: { path: { id } } })), onSuccess: () => { refresh(); go('billing'); }, onError: err });
  const link = useMutation({
    mutationFn: () => unwrap(api.POST('/billing/invoices/{id}/payment-link', { params: { path: { id } } })),
    onSuccess: (r) => { refresh(); void navigator.clipboard?.writeText(r.url).catch(() => undefined); toast({ text: t('bill.linkCreated'), tone: 'ok' }); }, onError: err,
  });

  if (q.isError) return <div role="alert" className="card p-6">{errStatus(q.error) === 404 ? t('bill.notFound') : t('common.error')} <a className="underline" href="#/billing">{t('nav.billing')}</a></div>;
  const inv = q.data;
  if (!inv) return <p className="text-muted" aria-live="polite">{t('common.loading')}</p>;
  const actions = allowedActions(inv, (m, a) => can(m, a));
  const has = (a: InvoiceAction) => actions.includes(a);
  return (
    <div className="space-y-3">
      <a href="#/billing" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} aria-hidden /> {t('nav.billing')}</a>
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{inv.kind !== 'invoice' && `${t(`bill.kind.${inv.kind}`)} `}{inv.number ?? t('bill.draftNo')}</h1>
        <StatusBadge status={inv.status} />
        <span className="text-muted">{inv.clientName}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {has('pdf') && <button className="btn" onClick={() => void openPdf(`/billing/invoices/${id}/pdf`).catch(err)}><FileDown size={14} aria-hidden /> {t('bill.pdf')}</button>}
          {has('send') && <button className="btn" onClick={() => setDialog('send')}>{t('bill.send')}</button>}
          {has('paymentLink') && <button className="btn" disabled={link.isPending} onClick={() => link.mutate()}>{t('bill.paymentLink')}</button>}
          {has('followUp') && <button className="btn" onClick={() => setDialog('followUp')}>{t('bill.followUp')}</button>}
          {has('note') && <button className="btn" onClick={() => setDialog('note')}>{t('bill.note')}</button>}
          {has('cancel') && <button className="btn" onClick={() => setDialog('cancel')}>{t('bill.cancelInvoice')}</button>}
          {has('delete') && <button className="btn" disabled={del.isPending} onClick={() => { if (confirm(t('bill.deleteConfirm'))) del.mutate(); }}>{t('bill.deleteDraft')}</button>}
          {has('issue') && <button className="btn btn-primary" onClick={() => setDialog('issue')}>{t('bill.issue')}</button>}
        </div>
      </header>
      {inv.status === 'cancelled' && <p className="card p-3 text-overdue">{t('bill.cancelledNotice', { reason: inv.cancelReason ?? '' })}</p>}
      {(inv.promiseToPay || inv.followupPaused) && <p className="text-sm text-muted">{inv.followupPaused ? t('bill.followupPaused') : t('bill.promiseOn', { date: inv.promiseToPay ?? '' })}</p>}
      <div className="grid gap-3 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-3">
          {has('edit') ? <DraftEditor inv={inv} onSaved={refresh} /> : <ReadOnlyLines inv={inv} />}
        </div>
        <aside className="card space-y-2 p-3">
          <div className="text-xs text-muted">{t(`bill.supply.${inv.supplyType}`)}{inv.placeOfSupply ? ` · ${t('bill.pos')} ${inv.placeOfSupply}` : ''}</div>
          <TaxSummary inv={inv} />
          {inv.status !== 'draft' && <dl className="grid grid-cols-[1fr_auto] gap-x-4 border-t border-border pt-2 text-sm">
            <dt>{t('bill.received')}</dt><dd className="text-right"><Money p={inv.allocatedPaise} /></dd>
            <dt>{t('bill.tds')}</dt><dd className="text-right"><Money p={inv.tdsPaise} /></dd>
            <dt>{t('bill.credited')}</dt><dd className="text-right"><Money p={inv.creditedPaise} /></dd>
            <dt className="font-semibold">{t('bill.balance')}</dt><dd className="text-right font-semibold" data-testid="balance"><Money p={inv.balancePaise} /></dd>
          </dl>}
          {inv.issueDate && <p className="text-xs text-muted">{t('bill.issuedOn', { date: inv.issueDate, due: inv.dueDate ?? '—' })}</p>}
        </aside>
      </div>
      {!!inv.paymentLinks?.length && <Section title={t('bill.paymentLinks')}>
        {inv.paymentLinks.map((l) => (
          <li key={l.id} className="flex items-center gap-2 text-sm">
            <span className="font-mono text-xs">{l.provider}</span><MockBadge /><Money p={l.amountPaise} /><span className="text-muted">{l.status}</span>
            <a className="truncate underline" href={l.url} target="_blank" rel="noreferrer">{l.url}</a>
            <button className="btn" aria-label={t('bill.copyLink')} onClick={() => void navigator.clipboard?.writeText(l.url ?? '').then(() => toast({ text: t('bill.copied'), tone: 'ok' }), () => undefined)}><Copy size={14} /></button>
          </li>
        ))}
      </Section>}
      {!!inv.allocations?.length && <Section title={t('bill.allocations')}>
        {inv.allocations.map((a) => <li key={a.id} className="text-sm">{a.receiptNumber} · {a.receivedOn} · <Money p={a.amountPaise} />{a.tdsPaise ? <> + {t('bill.tds')} <Money p={a.tdsPaise} /></> : null}</li>)}
      </Section>}
      {!!inv.notes?.length && <Section title={t('bill.notesIssued')}>
        {(inv.notes as Schemas['Invoice'][]).map((n) => <li key={n.id} className="text-sm"><a className="underline" href={`#/billing/${n.id}`}>{t(`bill.kind.${n.kind}`)} {n.number}</a> · <Money p={n.totalPaise} /></li>)}
      </Section>}
      {!!inv.messages?.length && <Section title={t('bill.messages')}>
        {inv.messages.map((m, i) => <li key={i} className="text-sm text-muted">{m.at?.slice(0, 10)} · {m.kind}{m.step ? ` #${m.step}` : ''} · {m.channel} · {m.status}</li>)}
      </Section>}
      {dialog === 'issue' && <IssueDialog id={id} onClose={() => setDialog(null)} onDone={() => { setDialog(null); refresh(); }} />}
      {dialog === 'cancel' && <CancelDialog id={id} onClose={() => setDialog(null)} onDone={() => { setDialog(null); refresh(); }} />}
      {dialog === 'note' && <NoteDialog inv={inv} onClose={() => setDialog(null)} onDone={() => { setDialog(null); refresh(); }} />}
      {dialog === 'followUp' && <FollowUpDialog inv={inv} onClose={() => setDialog(null)} onDone={() => { setDialog(null); refresh(); }} />}
      {dialog === 'send' && <SendDialog id={id} onClose={() => setDialog(null)} onDone={refresh} />}
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="card p-3"><h2 className="mb-1 font-semibold">{title}</h2><ul className="space-y-1">{children}</ul></section>
);

function DraftEditor({ inv, onSaved }: { inv: Detail; onSaved(): void }) {
  const t = useT();
  const err = useErr();
  const [lines, setLines] = useState<LineDraft[]>(() => fromDetail(inv));
  const [entityId, setEntityId] = useState(inv.entityId);
  const [notes, setNotes] = useState(inv.notes && typeof inv.notes === 'string' ? inv.notes : '');
  const save = useMutation({
    mutationFn: () => {
      const ls = toLinesIn(lines);
      if (!ls) throw new Error(t('bill.invalidLines'));
      return unwrap(api.PATCH('/billing/invoices/{id}', { params: { path: { id: inv.id } }, body: { entityId, notes: notes || null, lines: ls } }));
    },
    onSuccess: () => { onSaved(); toast({ text: t('bill.draftSaved'), tone: 'ok' }); }, onError: err,
  });
  return (
    <form className="card space-y-3 p-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <EntitySelect value={entityId} onChange={setEntityId} />
      <LinesEditor lines={lines} onChange={setLines} clientId={inv.clientId} />
      <Field label={t('bill.notes')}><textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <button className="btn btn-primary" disabled={save.isPending}>{t('bill.saveRecompute')}</button>
    </form>
  );
}

function ReadOnlyLines({ inv }: { inv: Detail }) {
  const t = useT();
  return (
    <div className="card overflow-auto" aria-label={t('bill.lines')}>
      <table className="table w-full">
        <thead><tr><th>{t('bill.line.description')}</th><th>{t('bill.line.sac')}</th><th className="text-right">{t('bill.line.qty')}</th><th className="text-right">{t('bill.line.rate')}</th><th className="text-right">{t('bill.line.discount')}</th><th className="text-right">{t('bill.line.gst')}</th><th className="text-right">{t('bill.line.taxable')}</th><th className="text-right">{t('bill.total')}</th></tr></thead>
        <tbody>{(inv.lines ?? []).map((l) => (
          <tr key={l.id}>
            <td>{l.description}{l.reimbursement && <span className="ml-1 text-xs text-muted">{t('bill.line.reimbursementHint')}</span>}</td>
            <td className="font-mono text-xs">{l.sac ?? '—'}</td><td className="text-right">{l.qty}</td>
            <td className="text-right"><Money p={l.ratePaise} /></td><td className="text-right"><Money p={l.discountPaise} /></td>
            <td className="text-right">{l.reimbursement ? '—' : `${l.gstRate}%`}</td>
            <td className="text-right"><Money p={l.taxablePaise} /></td><td className="text-right"><Money p={l.totalPaise} /></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function IssueDialog({ id, onClose, onDone }: { id: string; onClose(): void; onDone(): void }) {
  const t = useT();
  const err = useErr();
  const [issueDate, setIssueDate] = useState(todayIst());
  const [dueDate, setDueDate] = useState('');
  const issue = useMutation({
    mutationFn: () => unwrap(api.POST('/billing/invoices/{id}/issue', { params: { path: { id } }, body: { issueDate, dueDate: dueDate || null } })),
    onSuccess: (r) => { toast({ text: t('bill.issued', { number: r.number }), tone: 'ok' }); onDone(); }, onError: err,
  });
  return (
    <Dialog title={t('bill.issueTitle')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); issue.mutate(); }}>
        <p className="text-sm">{t('bill.issueConfirm')}</p>
        <Field label={t('bill.issueDate')}><input type="date" className="input" required value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></Field>
        <Field label={t('bill.dueDate')} hint={t('bill.dueDefault')}><input type="date" className="input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={issue.isPending}>{t('bill.issueNow')}</button></div>
      </form>
    </Dialog>
  );
}

function CancelDialog({ id, onClose, onDone }: { id: string; onClose(): void; onDone(): void }) {
  const t = useT();
  const err = useErr();
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => unwrap(api.POST('/billing/invoices/{id}/cancel', { params: { path: { id } }, body: { reason } })), onSuccess: onDone, onError: err });
  return (
    <Dialog title={t('bill.cancelInvoice')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <p className="text-sm text-muted">{t('bill.cancelHint')}</p>
        <Field label={t('bill.reason')}><input className="input" required value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={m.isPending}>{t('bill.cancelInvoice')}</button></div>
      </form>
    </Dialog>
  );
}

function NoteDialog({ inv, onClose, onDone }: { inv: Detail; onClose(): void; onDone(): void }) {
  const t = useT();
  const err = useErr();
  const [kind, setKind] = useState<'credit_note' | 'debit_note'>('credit_note');
  const [date, setDate] = useState(todayIst());
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState([{ description: '', taxable: '', gstRate: '', sac: '' }]);
  const m = useMutation({
    mutationFn: () => {
      const ls = lines.map((l) => ({ description: l.description, taxablePaise: parseRupees(l.taxable), sac: l.sac || null, ...(l.gstRate ? { gstRate: Number(l.gstRate) } : {}) }));
      if (ls.some((l) => l.taxablePaise === null || !l.description)) throw new Error(t('bill.invalidLines'));
      return unwrap(api.POST('/billing/invoices/{id}/notes', { params: { path: { id: inv.id } }, body: { kind, date, reason, lines: ls as Array<{ description: string; taxablePaise: number }> } }));
    },
    onSuccess: (r) => { toast({ text: t('bill.noteCreated', { number: r.number }), tone: 'ok' }); onDone(); }, onError: err,
  });
  const set = (i: number, p: Partial<(typeof lines)[number]>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  return (
    <Dialog title={t('bill.note')} onClose={onClose} wide>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('bill.noteKind')}><select className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="credit_note">{t('bill.kind.credit_note')}</option><option value="debit_note">{t('bill.kind.debit_note')}</option></select></Field>
          <Field label={t('bill.date')}><input type="date" className="input" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label={t('bill.reason')}><input className="input" required value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
        {kind === 'credit_note' && <p className="text-xs text-muted">{t('bill.creditLimit')} <Money p={inv.balancePaise} /></p>}
        {lines.map((l, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_8rem_5rem_6rem]">
            <input className="input" aria-label={t('bill.line.descriptionN', { n: i + 1 })} required value={l.description} onChange={(e) => set(i, { description: e.target.value })} />
            <RupeeInput label={t('bill.noteTaxableN', { n: i + 1 })} required value={l.taxable} onChange={(v) => set(i, { taxable: v })} />
            <input className="input" aria-label={t('bill.line.gstN', { n: i + 1 })} placeholder={t('bill.line.gstDefault')} value={l.gstRate} onChange={(e) => set(i, { gstRate: e.target.value })} />
            <input className="input font-mono" aria-label={t('bill.line.sacN', { n: i + 1 })} value={l.sac} onChange={(e) => set(i, { sac: e.target.value })} />
          </div>
        ))}
        <button type="button" className="btn" onClick={() => setLines([...lines, { description: '', taxable: '', gstRate: '', sac: '' }])}><Plus size={14} aria-hidden /> {t('bill.line.add')}</button>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={m.isPending}>{t('bill.issueNow')}</button></div>
      </form>
    </Dialog>
  );
}

function FollowUpDialog({ inv, onClose, onDone }: { inv: Detail; onClose(): void; onDone(): void }) {
  const t = useT();
  const err = useErr();
  const [promise, setPromise] = useState(inv.promiseToPay ?? '');
  const [paused, setPaused] = useState(!!inv.followupPaused);
  const m = useMutation({ mutationFn: () => unwrap(api.POST('/billing/invoices/{id}/follow-up', { params: { path: { id: inv.id } }, body: { promiseToPay: promise || null, paused } })), onSuccess: onDone, onError: err });
  return (
    <Dialog title={t('bill.followUp')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label={t('bill.promiseToPay')}><input type="date" className="input" value={promise} onChange={(e) => setPromise(e.target.value)} /></Field>
        <label className="flex items-center gap-2"><input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} /> {t('bill.pauseFollowups')}</label>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={m.isPending}>{t('common.save')}</button></div>
      </form>
    </Dialog>
  );
}

function SendDialog({ id, onClose, onDone }: { id: string; onClose(): void; onDone(): void }) {
  const t = useT();
  const err = useErr();
  const [result, setResult] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (channel: 'email' | 'whatsapp') => unwrap(api.POST('/billing/invoices/{id}/send', { params: { path: { id } }, body: { channel } })),
    onSuccess: (r) => { setResult(r.status ?? 'sent'); onDone(); }, onError: err,
  });
  return (
    <Dialog title={t('bill.send')} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-muted">{t('bill.sendHint')}</p>
        <div className="flex gap-2">
          <button className="btn" disabled={m.isPending} onClick={() => m.mutate('email')}>{t('bill.sendEmail')}</button>
          <button className="btn" disabled={m.isPending} onClick={() => m.mutate('whatsapp')}>{t('bill.sendWhatsApp')}</button><MockBadge />
        </div>
        {result && <p role="status" className="text-done">{t('bill.sendResult', { status: result })}</p>}
      </div>
    </Dialog>
  );
}
