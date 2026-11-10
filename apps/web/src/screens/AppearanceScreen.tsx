import { accents, type AccentName } from '@worko/ui-tokens';
import { Check, Monitor, Moon, RotateCcw, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { NAV } from '../components/nav';
import { useT } from '../lib/i18n';
import { useCan } from '../lib/me';
import { AboutUpdates } from '../components/UpdateBanner';
import { DEFAULT_PREFS, usePrefs, type UiPrefs } from '../lib/prefs';

/** Personal display settings. Saved per user on the server, so they follow the user to every device. */
export function AppearanceScreen() {
  const t = useT();
  const can = useCan();
  const { prefs, update, reset } = usePrefs();
  const p = { ...DEFAULT_PREFS, ...prefs };
  const set = (patch: UiPrefs) => void update(patch);
  const hidden = new Set(p.hiddenModules);
  const toggleModule = (r: string) => { const n = new Set(hidden); if (n.has(r)) n.delete(r); else n.add(r); set({ hiddenModules: [...n] }); };
  const modules = NAV.filter((n) => n.route !== 'home' && n.route !== 'appearance' && (!n.perm || can(...n.perm)));

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <h1 className="text-[26px] font-bold">{t('appearance.title')}</h1>
          <p className="text-muted">{t('appearance.subtitle')}</p>
        </div>
        <button className="btn" onClick={() => void reset()}><RotateCcw size={14} aria-hidden /> {t('appearance.reset')}</button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          <Section title={t('appearance.theme')}>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('appearance.theme')}>
              {([['system', Monitor, t('appearance.theme.system')], ['light', Sun, t('appearance.theme.light')], ['dark', Moon, t('appearance.theme.dark')]] as const).map(([k, Icon, label]) => (
                <Choice key={k} on={p.theme === k} onClick={() => set({ theme: k })} label={label}><Icon size={18} aria-hidden /></Choice>
              ))}
            </div>
          </Section>

          <Section title={t('appearance.accent')} hint={t('appearance.accentHint')}>
            <div className="flex flex-wrap gap-3" role="radiogroup" aria-label={t('appearance.accent')}>
              {(Object.keys(accents) as AccentName[]).map((k) => (
                <button key={k} role="radio" aria-checked={p.accent === k} aria-label={accents[k]!.label} title={accents[k]!.label} onClick={() => set({ accent: k })}
                  className={`relative flex h-11 w-11 items-center justify-center rounded-full text-white shadow-sm transition-transform hover:scale-110 ${p.accent === k ? 'ring-2 ring-fg ring-offset-2 ring-offset-surface-solid' : ''}`}
                  style={{ background: `linear-gradient(135deg, ${accents[k]!.light.heroA}, ${accents[k]!.light.primary})` }}>
                  {p.accent === k && <Check size={18} aria-hidden />}
                </button>
              ))}
            </div>
          </Section>

          <Section title={t('appearance.textSize')}>
            <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label={t('appearance.textSize')}>
              {([['sm', 'A', 'text-xs'], ['md', 'A', 'text-base'], ['lg', 'A', 'text-lg'], ['xl', 'A', 'text-2xl']] as const).map(([k, a, cls]) => (
                <Choice key={k} on={p.fontScale === k} onClick={() => set({ fontScale: k })} label={t(`appearance.size.${k}`)}><span className={`font-bold ${cls}`}>{a}</span></Choice>
              ))}
            </div>
          </Section>

          <Section title={t('appearance.layout')}>
            <div className="grid gap-2 sm:grid-cols-2">
              <Toggle on={p.density === 'compact'} onChange={(v) => set({ density: v ? 'compact' : 'comfortable' })} label={t('appearance.compact')} hint={t('appearance.compactHint')} />
              <Toggle on={p.glass} onChange={(v) => set({ glass: v })} label={t('appearance.glass')} hint={t('appearance.glassHint')} />
              <Toggle on={p.motion === 'full'} onChange={(v) => set({ motion: v ? 'full' : 'reduced' })} label={t('appearance.motion')} hint={t('appearance.motionHint')} />
            </div>
          </Section>

          <Section title={t('update.title')}><AboutUpdates /></Section>

          <Section title={t('appearance.modules')} hint={t('appearance.modulesHint')}>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {modules.map((n) => (
                <label key={n.route} className="flex cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 transition-colors hover:bg-surface-alt">
                  <input type="checkbox" className="h-4 w-4 accent-[var(--w-primary)]" checked={!hidden.has(n.route)} onChange={() => toggleModule(n.route)} />
                  <n.icon size={16} aria-hidden className="text-muted" /> {t(n.label)}
                </label>
              ))}
            </div>
          </Section>
        </div>

        <div className="lg:sticky lg:top-0 lg:self-start">
          <Section title={t('appearance.preview')}>
            <div className="space-y-3">
              <div className="tile hero"><div className="text-sm font-semibold text-white/90">{t('dash.stat.total')}</div><div className="mt-1 text-[36px] font-bold leading-none">128</div></div>
              <div className="card p-4">
                <div className="font-semibold">{t('appearance.previewCard')}</div>
                <p className="mt-1 text-muted">{t('appearance.previewText')}</p>
                <div className="mt-3 flex flex-wrap gap-2"><button className="btn btn-primary">{t('dash.addTask')}</button><button className="btn">{t('common.cancel')}</button></div>
                <div className="mt-3 flex flex-wrap gap-1.5"><span className="pill bg-primary-soft text-primary">{t('tasks.status.done')}</span><span className="pill bg-surface-alt text-muted">{t('tasks.status.open')}</span></div>
              </div>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="card p-5" aria-label={title}>
      <h2 className="text-[16px] font-semibold">{title}</h2>
      {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Choice({ on, onClick, label, children }: { on: boolean; onClick(): void; label: string; children: ReactNode }) {
  return (
    <button role="radio" aria-checked={on} aria-label={label} onClick={onClick}
      className={`flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3 transition-all duration-200 hover:-translate-y-0.5 ${on ? 'border-primary bg-primary-soft text-fg shadow-sm' : 'border-border bg-surface hover:bg-surface-alt'}`}>
      {children}<span className="text-sm font-medium">{label}</span>
    </button>
  );
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange(v: boolean): void; label: string; hint: string }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)} className="flex items-start gap-3 rounded-xl border border-border bg-surface p-3 text-left transition-colors hover:bg-surface-alt">
      <span aria-hidden className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${on ? 'bg-primary' : 'bg-border'}`}>
        <span className={`h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${on ? 'translate-x-4' : ''}`} />
      </span>
      <span><span className="block font-medium">{label}</span><span className="block text-sm text-muted">{hint}</span></span>
    </button>
  );
}
