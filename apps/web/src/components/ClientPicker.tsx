import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useDebounced } from '../lib/http';
import { useT } from '../lib/i18n';
import { api, unwrap } from '../lib/session';

export type PickedClient = { id: string; name: string };

/** Search-as-you-type client combobox (server search, so it scales to large client lists). */
export function ClientPicker({ value, onChange, label, excludeId }: { value: PickedClient | null; onChange(c: PickedClient | null): void; label: string; excludeId?: string }) {
  const t = useT();
  const id = useId();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const dq = useDebounced(q, 250);
  const res = useQuery({
    queryKey: ['clients', 'pick', dq],
    queryFn: () => unwrap(api.GET('/clients', { params: { query: { q: dq, limit: 8 } } })),
    enabled: open && dq.trim().length > 0,
  });
  const items = (res.data?.items ?? []).filter((c) => c.id !== excludeId);
  const pick = (c?: PickedClient) => { if (!c) return; onChange({ id: c.id, name: c.name }); setQ(''); setOpen(false); };

  if (value) return (
    <div>
      <span className="label">{label}</span>
      <div className="flex items-center gap-2"><span className="input flex-1 truncate">{value.name}</span>
        <button type="button" className="btn" onClick={() => onChange(null)}>{t('clients.change')}</button></div>
    </div>
  );
  return (
    <div className="relative">
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} className="input" role="combobox" aria-expanded={open && items.length > 0} aria-controls={`${id}-list`} aria-autocomplete="list"
        placeholder={t('clients.searchPlaceholder')} value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setSel(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
          if (e.key === 'Enter' && open && items.length) { e.preventDefault(); pick(items[sel]); }
        }} />
      {open && items.length > 0 && (
        <ul id={`${id}-list`} role="listbox" className="card absolute z-10 mt-1 max-h-60 w-full overflow-auto shadow-lg">
          {items.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === sel} onMouseDown={(e) => { e.preventDefault(); pick(c); }} onMouseEnter={() => setSel(i)}
              className={`cursor-pointer px-3 py-1.5 ${i === sel ? 'bg-surface-alt' : ''}`}>
              {c.name} <span className="text-xs text-muted">{[c.fileNo, c.pan].filter(Boolean).join(' · ')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
