import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ENTITY_TYPES, formatINR, PROPOSAL_FREQUENCIES, type ProposalTotals, type VersionDiff } from '@worko/domain';
import { formatDateTime, type MessageKey } from '@worko/i18n';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, Field } from '../../components/Dialog';
import { todayIst } from '../../lib/http';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { useRoute } from '../../lib/router';
import { api } from '../../lib/session';
import { as, asFull, body, useCrmSettings, type Conversion, type Proposal } from './api';
import { defaultRate, diffRows, emptyLine, lineFromStored, linePayload, paiseToRupees, proposalWebHref, totalsRows, type ProposalLineIn, type Rate } from './logic';

type Svc = { id: string; name: string; key: string; active: boolean };
type Tpl = { id: string; name: string; channel: string; status: string };
const freqKey = (f: string) => `p9.freq.${f}` as MessageKey;

export function TotalsTable({ totals }: { totals: ProposalTotals | null | undefined }) {
  const t = useT();
  const rows = totalsRows(totals);
  if (!rows.length) return null;
  return (
    <table className="table w-full text-sm" aria-label={t('p9.prop.totals')}>
      <thead><tr><th>{t('p9.prop.cycle')}</th><th className="text-right">{t('p9.prop.taxable')}</th><th className="text-right">GST</th><th className="text-right">{t('p9.prop.total')}</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.key} className={r.key === 'firstYear' ? 'font-semibold' : ''}><td>{r.key === 'firstYear' ? t('p9.prop.firstYear') : t(freqKey(r.key))}</td>
          <td className="text-right tabular-nums">{formatINR(r.taxablePaise)}</td><td className="text-right tabular-nums">{formatINR(r.taxPaise)}</td><td className="text-right tabular-nums">{formatINR(r.totalPaise)}</td></tr>))}</tbody>
    </table>
  );
}

export function DiffView({ diff }: { diff: VersionDiff }) {
  const t = useT();
  const rows = diffRows(diff, (f) => t(`p9.diff.f.${f}` as MessageKey));
  if (!rows.length) return <p className="text-sm text-muted">{t('p9.diff.none')}</p>;
  const tone = { added: 'text-done', removed: 'text-overdue line-through', changed: 'text-due-soon', terms: '', validity: '' } as const;
  return (
    <ul className="space-y-1 text-sm" aria-label={t('p9.diff.title')}>
      {rows.map((r, i) => (
        <li key={i}><span className="mr-1 rounded bg-surface-alt px-1 text-xs">{t(`p9.diff.${r.kind}` as MessageKey)}</span><span className={tone[r.kind]}>{r.label}</span>
          {r.details.map((d) => <span key={d} className="block pl-4 text-xs text-muted">{d}</span>)}</li>
      ))}
    </ul>
  );
}

/** Create (leadId) or edit (proposalId) a proposal; versions, diff, send, withdraw, convert. */
export function ProposalEditor({ proposalId, leadId }: { proposalId?: string; leadId?: string }) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const go = useRoute((s) => s.go);
  const settings = useCrmSettings();
  const p = useQuery({ queryKey: ['proposal', proposalId], enabled: !!proposalId, retry: false, queryFn: () => as<Proposal>(api.GET('/proposals/{id}', { params: { path: { id: proposalId! } } })) });
  const services = useQuery({ queryKey: ['service-types'], queryFn: () => as<Svc[]>(api.GET('/service-types')), staleTime: 60_000 });
  const rates = useQuery({ queryKey: ['billing', 'rates'], queryFn: () => as<Rate[]>(api.GET('/billing/rates', { params: { query: {} } })), staleTime: 60_000, retry: false });
  const entities = useQuery({ queryKey: ['billing', 'entities'], queryFn: () => as<Array<{ id: string; name: string }>>(api.GET('/billing/entities')), staleTime: 60_000, retry: false });

  const [title, setTitle] = useState('');
  const [entityId, setEntityId] = useState('');
  const [pos, setPos] = useState('');
  const [lines, setLines] = useState<ProposalLineIn[]>([emptyLine()]);
  const [terms, setTerms] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [totals, setTotals] = useState<ProposalTotals | null>(null);
  const [dlg, setDlg] = useState<'send' | 'convert' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const cur = p.data?.versions.find((v) => v.version === p.data!.currentVersion);
  useEffect(() => {
    if (p.data && cur) {
      setTitle(p.data.title); setEntityId(p.data.entityId ?? ''); setPos(p.data.placeOfSupply ?? '');
      setLines(cur.lines.map((l) => lineFromStored(l, false))); setTerms(cur.terms ?? ''); setValidUntil(cur.validUntil ?? ''); setTotals(cur.totals); setDirty(false);
    }
  }, [p.data, cur]);
  useEffect(() => { if (!proposalId && settings.data && !terms) setTerms(settings.data.defaultTerms); }, [proposalId, settings.data, terms]);

  const editLine = (i: number, patch: Partial<ProposalLineIn>) => { setDirty(true); setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l))); };
  const pickService = (i: number, id: string) => {
    const s = services.data?.find((x) => x.id === id);
    const r = id ? defaultRate(rates.data ?? [], id, todayIst()) : null;
    editLine(i, { serviceTypeId: id || null, description: s?.name ?? '', feeRupees: r ? paiseToRupees(r.amountPaise) : '', override: !!id && !r });
  };

  const save = useMutation({
    mutationFn: async () => {
      const payload = lines.map(linePayload);
      const bad = payload.find((x) => 'error' in x);
      if (bad) throw new Error(t(`p9.prop.err.${(bad as { error: string }).error}` as MessageKey));
      const b = { title: title.trim(), lines: payload, terms: terms.trim() || null, validUntil: validUntil || null, entityId: entityId || null, placeOfSupply: pos || null };
      if (proposalId) return as<{ version: number; newVersion: boolean; totals: ProposalTotals }>(api.PATCH('/proposals/{id}', { params: { path: { id: proposalId } }, body: body(b) }));
      return as<{ id: string; version: number; totals: ProposalTotals }>(api.POST('/leads/{id}/proposals', { params: { path: { id: leadId! } }, body: body(b) }));
    },
    onSuccess: (r) => {
      setErr(null); setDirty(false); setTotals(r.totals);
      if ('newVersion' in r && r.newVersion) setNotice(t('p9.prop.newVersion', { v: r.version }));
      void qc.invalidateQueries({ queryKey: ['leads'] });
      if (proposalId) void qc.invalidateQueries({ queryKey: ['proposal', proposalId] }); else if ('id' in r) go(`leads/p/${r.id}`);
    },
    onError: (e) => setErr((e as Error).message),
  });
  const withdraw = useMutation({
    mutationFn: () => as(api.POST('/proposals/{id}/withdraw', { params: { path: { id: proposalId! } } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['proposal', proposalId] }), onError: (e) => setErr((e as Error).message),
  });

  if (proposalId && p.isError) return <p role="alert" className="card p-4">{t('p9.notFound')}</p>;
  if (proposalId && !p.data) return <p className="text-muted">{t('common.loading')}</p>;
  const status = p.data?.status ?? 'draft';
  const editable = can('leads', proposalId ? 'edit' : 'create') && ['draft', 'sent'].includes(status);
  const back = p.data?.leadId ?? leadId;

  return (
    <div className="space-y-3">
      <a href={`#/leads/${back}`} className="text-sm text-muted hover:text-fg">← {p.data ? (p.data.company || p.data.leadName) : t('p9.leads.title')}</a>
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="flex-1 text-xl font-semibold">{p.data ? `${p.data.number} · v${p.data.currentVersion}` : t('p9.prop.new')}</h1>
        {p.data && <span className="rounded bg-surface-alt px-2 py-0.5 text-sm" data-testid="prop-status">{t(`p9.pst.${status}` as MessageKey)}</span>}
        {p.data && editable && can('leads', 'edit') && <button className="btn btn-primary" disabled={dirty} title={dirty ? t('p9.prop.saveFirst') : undefined} onClick={() => setDlg('send')}>{t('p9.prop.send')}</button>}
        {p.data && editable && can('leads', 'edit') && <button className="btn" onClick={() => confirm(t('p9.prop.withdrawConfirm')) && withdraw.mutate()}>{t('p9.prop.withdraw')}</button>}
        {p.data && status === 'accepted' && can('leads', 'approve') && <button className="btn btn-primary" onClick={() => setDlg('convert')}>{p.data.convertedAt ? t('p9.conv.view') : t('p9.conv.title')}</button>}
      </header>
      {p.data?.acceptedName && <p className="text-sm text-done">{t('p9.prop.acceptedBy', { name: p.data.acceptedName, v: p.data.acceptedVersion ?? '' })}</p>}
      {p.data?.declinedReason && <p className="text-sm text-overdue">{t('p9.prop.declinedWith', { reason: p.data.declinedReason })}</p>}
      {notice && <p role="status" className="text-sm text-due-soon">{notice}</p>}
      {status === 'sent' && editable && <p className="text-xs text-muted">{t('p9.prop.sentEditHint')}</p>}

      <form className="card space-y-3 p-4" aria-label={t('p9.prop.editor')} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <fieldset disabled={!editable} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('p9.prop.titleF')}><input className="input" value={title} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} required /></Field>
            <Field label={t('p9.prop.entity')}><select className="input" value={entityId} onChange={(e) => { setEntityId(e.target.value); setDirty(true); }}>
              <option value="">{t('p9.prop.defaultEntity')}</option>{(entities.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field label={t('p9.prop.pos')} hint={t('p9.prop.posHint')}><input className="input" value={pos} onChange={(e) => { setPos(e.target.value.replace(/\D/g, '').slice(0, 2)); setDirty(true); }} inputMode="numeric" /></Field>
          </div>
          <div className="overflow-x-auto">
            <table className="table w-full text-sm">
              <thead><tr><th>{t('p9.prop.service')}</th><th>{t('p9.prop.desc')}</th><th>{t('p9.prop.freq')}</th><th>{t('p9.prop.qty')}</th><th>{t('p9.prop.fee')}</th><th>GST %</th><th>{t('p9.prop.discount')}</th><th><span className="sr-only">{t('common.delete')}</span></th></tr></thead>
              <tbody>{lines.map((l, i) => (
                <tr key={i} data-testid={`line-${i}`}>
                  <td><select className="input" aria-label={t('p9.prop.serviceN', { n: i + 1 })} value={l.serviceTypeId ?? ''} onChange={(e) => pickService(i, e.target.value)}>
                    <option value="">{t('p9.prop.freeLine')}</option>{(services.data ?? []).filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></td>
                  <td><input className="input" aria-label={t('p9.prop.descN', { n: i + 1 })} value={l.description} onChange={(e) => editLine(i, { description: e.target.value })} /></td>
                  <td><select className="input" aria-label={t('p9.prop.freqN', { n: i + 1 })} value={l.frequency} onChange={(e) => editLine(i, { frequency: e.target.value as ProposalLineIn['frequency'] })}>
                    {PROPOSAL_FREQUENCIES.map((f) => <option key={f} value={f}>{t(freqKey(f))}</option>)}</select></td>
                  <td><input className="input w-16" type="number" min={0.01} step={0.01} aria-label={t('p9.prop.qtyN', { n: i + 1 })} value={l.qty} onChange={(e) => editLine(i, { qty: Number(e.target.value) })} /></td>
                  <td><input className="input w-28 text-right" inputMode="decimal" aria-label={t('p9.prop.feeN', { n: i + 1 })} value={l.feeRupees} disabled={!!l.serviceTypeId && !l.override}
                      onChange={(e) => editLine(i, { feeRupees: e.target.value })} />
                    {l.serviceTypeId && <label className="mt-0.5 flex items-center gap-1 text-xs"><input type="checkbox" checked={l.override} onChange={(e) => editLine(i, { override: e.target.checked })} /> {t('p9.prop.override')}</label>}
                    {l.serviceTypeId && !l.override && <span className="block text-xs text-muted">{t('p9.prop.fromRate')}</span>}</td>
                  <td><input className="input w-16" inputMode="decimal" aria-label={t('p9.prop.gstN', { n: i + 1 })} placeholder={t('p9.prop.auto')} value={l.gstRate} onChange={(e) => editLine(i, { gstRate: e.target.value })} /></td>
                  <td><input className="input w-24 text-right" inputMode="decimal" aria-label={t('p9.prop.discN', { n: i + 1 })} value={l.discountRupees} onChange={(e) => editLine(i, { discountRupees: e.target.value })} /></td>
                  <td>{lines.length > 1 && <button type="button" className="rounded p-1 text-overdue" aria-label={t('p9.prop.removeN', { n: i + 1 })} onClick={() => { setDirty(true); setLines((ls) => ls.filter((_, k) => k !== i)); }}><Trash2 size={14} /></button>}</td>
                </tr>))}</tbody>
            </table>
          </div>
          <button type="button" className="btn" onClick={() => { setDirty(true); setLines((ls) => [...ls, emptyLine()]); }}><Plus size={14} aria-hidden /> {t('p9.prop.addLine')}</button>
          <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
            <Field label={t('p9.prop.terms')}><textarea className="input" rows={3} value={terms} onChange={(e) => { setTerms(e.target.value); setDirty(true); }} /></Field>
            <Field label={t('p9.prop.validUntil')} hint={settings.data ? t('p9.prop.validHint', { n: settings.data.proposalValidityDays }) : undefined}>
              <input type="date" className="input" value={validUntil} onChange={(e) => { setValidUntil(e.target.value); setDirty(true); }} /></Field>
          </div>
        </fieldset>
        {err && <p role="alert" className="text-sm text-overdue">{err}</p>}
        {editable && <button className="btn btn-primary" disabled={save.isPending || !title.trim()}>{proposalId ? t('p9.prop.save') : t('p9.prop.create')}</button>}
      </form>

      <section className="card space-y-2 p-4" aria-label={t('p9.prop.totals')}>
        <h2 className="font-semibold">{t('p9.prop.totals')}</h2>
        {dirty && <p className="text-xs text-due-soon">{t('p9.prop.previewStale')}</p>}
        {totals ? <TotalsTable totals={totals} /> : <p className="text-sm text-muted">{t('p9.prop.previewHint')}</p>}
      </section>

      {p.data && p.data.versions.length > 0 && <Versions p={p.data} />}
      {dlg === 'send' && p.data && <SendDialog p={p.data} onClose={() => setDlg(null)} />}
      {dlg === 'convert' && p.data && <ConvertDialog p={p.data} onClose={() => setDlg(null)} />}
    </div>
  );
}

function Versions({ p }: { p: Proposal }) {
  const t = useT();
  const vs = p.versions;
  const [from, setFrom] = useState(vs.length > 1 ? vs[vs.length - 2]!.version : 1);
  const [to, setTo] = useState(vs[vs.length - 1]!.version);
  const diff = useQuery({ queryKey: ['proposal', p.id, 'diff', from, to], enabled: vs.length > 1 && from !== to,
    queryFn: () => as<VersionDiff>(api.GET('/proposals/{id}/diff', { params: { path: { id: p.id }, query: { from, to } } })) });
  return (
    <section className="card space-y-2 p-4" aria-label={t('p9.prop.versions')}>
      <h2 className="font-semibold">{t('p9.prop.versions')}</h2>
      <ul className="divide-y divide-border text-sm">{vs.map((v) => (
        <li key={v.version} className="flex flex-wrap gap-2 py-1"><span className="w-10 font-medium">v{v.version}</span>
          <span className="flex-1 text-muted">{v.sentAt ? t('p9.prop.sentOn', { at: formatDateTime(v.sentAt), via: v.sentVia ?? '' }) : t('p9.pst.draft')}</span>
          <span className="tabular-nums">{formatINR(Math.round(v.totals?.firstYear?.totalPaise ?? 0))}</span></li>))}</ul>
      {vs.length > 1 && <>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('p9.diff.from')}><select className="input w-auto" value={from} onChange={(e) => setFrom(Number(e.target.value))}>{vs.map((v) => <option key={v.version} value={v.version}>v{v.version}</option>)}</select></Field>
          <Field label={t('p9.diff.to')}><select className="input w-auto" value={to} onChange={(e) => setTo(Number(e.target.value))}>{vs.map((v) => <option key={v.version} value={v.version}>v{v.version}</option>)}</select></Field>
        </div>
        {from === to ? <p className="text-sm text-muted">{t('p9.diff.pick')}</p> : diff.data ? <DiffView diff={diff.data} /> : <p className="text-muted">{t('common.loading')}</p>}
      </>}
    </section>
  );
}

function SendDialog({ p, onClose }: { p: Proposal; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [channel, setChannel] = useState<'email' | 'whatsapp' | 'sms'>('email');
  const [templateId, setTemplateId] = useState('');
  const tpls = useQuery({ queryKey: ['comm', 'templates'], queryFn: () => as<Tpl[]>(api.GET('/comm/templates')), retry: false, staleTime: 60_000 });
  const send = useMutation({
    mutationFn: () => as<{ version: number; link: string; status: string }>(api.POST('/proposals/{id}/send', { params: { path: { id: p.id } }, body: { channel, templateId: templateId || null } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['proposal', p.id] }); void qc.invalidateQueries({ queryKey: ['leads'] }); },
  });
  const options = (tpls.data ?? []).filter((x) => x.channel === channel && x.status === 'approved');
  return (
    <Dialog title={t('p9.prop.send')} onClose={onClose}>
      {send.data ? (
        <div role="status" className="space-y-2">
          <p>{t('p9.send.done', { v: send.data.version, status: send.data.status })}</p>
          <p className="text-sm">{t('p9.send.link')} <a className="break-all underline" href={proposalWebHref(send.data.link)} target="_blank" rel="noreferrer">{proposalWebHref(send.data.link)}</a></p>
          <button className="btn" onClick={onClose}>{t('common.close')}</button>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
          <Field label={t('p9.send.channel')}><select className="input" value={channel} onChange={(e) => { setChannel(e.target.value as typeof channel); setTemplateId(''); }}>
            {(['email', 'whatsapp', 'sms'] as const).map((c) => <option key={c} value={c}>{t(`p9.ch.${c}` as MessageKey)}</option>)}</select></Field>
          <Field label={t('p9.send.template')} hint={t('p9.send.templateHint')}><select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">{t('p9.send.defaultMsg')}</option>{options.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          <p className="text-xs text-muted">{t('p9.send.freeze')}</p>
          {send.isError && <p role="alert" className="text-sm text-overdue">{(send.error as Error).message}</p>}
          <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={send.isPending}>{t('p9.prop.send')}</button></div>
        </form>
      )}
    </Dialog>
  );
}

type Candidate = { id: string; name: string; fileNo?: string | null; matchedOn: string[] };
export function ConvertDialog({ p, onClose }: { p: Proposal; onClose(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [invite, setInvite] = useState(true);
  const [esign, setEsign] = useState(false);
  const [entityType, setEntityType] = useState('');
  const [dups, setDups] = useState<{ candidates: Candidate[]; hidden: number } | null>(null);
  const [choice, setChoice] = useState<string>('');
  const [result, setResult] = useState<Conversion | null>(p.conversion && p.convertedAt ? p.conversion : null);
  const conv = useMutation({
    mutationFn: () => asFull<Conversion>(api.POST('/proposals/{id}/convert', { params: { path: { id: p.id } }, body: body({
      inviteToPortal: invite, sendForEsign: esign, ...(entityType ? { entityType } : {}),
      ...(choice === 'new' ? { ignoreDuplicates: true } : choice ? { clientId: choice } : {}),
    }) })),
    onSuccess: (r) => { setResult(r); void qc.invalidateQueries({ queryKey: ['proposal', p.id] }); void qc.invalidateQueries({ queryKey: ['leads'] }); void qc.invalidateQueries({ queryKey: ['clients'] }); },
    onError: (e) => {
      const b = (e as { body?: { code?: string; candidates?: Candidate[]; hidden?: number } }).body;
      if (b?.code === 'duplicate_client') setDups({ candidates: b.candidates ?? [], hidden: b.hidden ?? 0 });
    },
  });
  if (result) return (
    <Dialog title={t('p9.conv.done')} onClose={onClose}>
      <div role="status" className="space-y-2 text-sm" data-testid="convert-result">
        <p>{result.alreadyConverted ? t('p9.conv.already') : result.createdClient ? t('p9.conv.created') : t('p9.conv.linked')}</p>
        <ul className="list-disc pl-5">
          <li><a className="underline" href={`#/clients/${result.clientId}`}>{t('p9.conv.openClient')}</a></li>
          {result.letterDocumentId && <li><a className="underline" href={`#/clients/${result.clientId}`}>{t('p9.conv.letter')}</a></li>}
          {result.esignRequestId && <li><a className="underline" href="#/esign">{t('p9.conv.esign')}</a></li>}
          {result.portal && <li>{result.portal.status === 'needs_confirmation' ? t('p9.conv.portalConfirm') : t('p9.conv.portal', { status: result.portal.invite?.status ?? 'ok' })}</li>}
        </ul>
        <button className="btn" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Dialog>
  );
  const code = (conv.error as { code?: string } | null)?.code;
  return (
    <Dialog title={t('p9.conv.title')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); conv.mutate(); }}>
        <Field label={t('p9.conv.entityType')} hint={t('p9.conv.entityHint')}><select className="input" value={entityType} onChange={(e) => setEntityType(e.target.value)}>
          <option value="">{t('p9.conv.fromLead')}</option>{ENTITY_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}</select></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={invite} onChange={(e) => setInvite(e.target.checked)} /> {t('p9.conv.invite')}</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={esign} onChange={(e) => setEsign(e.target.checked)} /> {t('p9.conv.sendEsign')}</label>
        {dups && (
          <fieldset className="space-y-1 rounded border border-due-soon p-2 text-sm" data-testid="convert-dups">
            <legend className="px-1 font-medium text-due-soon">{t('p9.conv.dupTitle')}</legend>
            {dups.candidates.map((c) => <label key={c.id} className="flex items-center gap-2"><input type="radio" name="dup" checked={choice === c.id} onChange={() => setChoice(c.id)} /> {t('p9.conv.useExisting', { name: c.name })} <span className="text-muted">({c.matchedOn.join(', ')})</span></label>)}
            {dups.hidden > 0 && <p className="text-muted">{t('p9.dup.hidden', { n: dups.hidden })}</p>}
            <label className="flex items-center gap-2"><input type="radio" name="dup" checked={choice === 'new'} onChange={() => setChoice('new')} /> {t('p9.conv.createAnyway')}</label>
          </fieldset>
        )}
        {conv.isError && code !== 'duplicate_client' && <p role="alert" className="text-sm text-overdue">{(conv.error as Error).message}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" disabled={conv.isPending || (!!dups && !choice)}>{t('p9.conv.go')}</button></div>
      </form>
    </Dialog>
  );
}
