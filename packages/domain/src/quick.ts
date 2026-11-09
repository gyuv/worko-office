/**
 * One-line task capture: "GST return #acme tomorrow !high @ravi".
 * Pure: the caller passes today's IST date and the people list; client tokens are resolved by the caller (server search).
 */
export type QuickPerson = { id: string; name: string };
export type QuickPriority = 'low' | 'normal' | 'high' | 'urgent';
export type QuickParse = {
  title: string;
  actBy: string | null;
  priority: QuickPriority;
  assignee: QuickPerson | null;
  clientQuery: string | null;
  /** Tokens recognised, in input order, for the live preview chips. */
  tokens: { kind: 'date' | 'priority' | 'person' | 'client'; text: string }[];
};

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const pad = (n: number) => String(n).padStart(2, '0');

/** Next date on or after tomorrow with day-month d/m (rolls into next year if already past). */
function dayMonth(today: string, d: number, m: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  let y = Number(today.slice(0, 4));
  let iso = `${y}-${pad(m)}-${pad(d)}`;
  if (new Date(`${iso}T00:00:00Z`).getUTCDate() !== d) return null;
  if (iso < today) { y += 1; iso = `${y}-${pad(m)}-${pad(d)}`; }
  return iso;
}

/** Recognises a date phrase at the start of `words`; returns [date, wordsUsed]. */
function dateAt(words: string[], today: string): [string, number] | null {
  const w = (words[0] ?? '').toLowerCase().replace(/[,.]$/, '');
  const w2 = (words[1] ?? '').toLowerCase().replace(/[,.]$/, '');
  if (w === 'today' || w === 'tod') return [today, 1];
  if (w === 'tomorrow' || w === 'tmrw' || w === 'tmr') return [addDays(today, 1), 1];
  if (w === 'eow') return [addDays(today, (5 - dow(today) + 7) % 7 || 7), 1];
  if (w === 'next' && w2 === 'week') return [addDays(today, ((1 - dow(today) + 7) % 7) || 7), 2];
  if (w === 'in' && /^\d{1,3}$/.test(w2) && /^(day|days|d)$/.test((words[2] ?? '').toLowerCase())) return [addDays(today, Number(w2)), 3];
  if (w === 'in' && /^\d{1,2}$/.test(w2) && /^(week|weeks|w)$/.test((words[2] ?? '').toLowerCase())) return [addDays(today, Number(w2) * 7), 3];
  const di = DAYS.findIndex((d) => w.startsWith(d) && w.length <= 9 && (w.length === 3 || `${d}${w.slice(3)}`.match(/^(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(day|nesday|rsday|urday|sday)?$/)));
  if (di >= 0) return [addDays(today, ((di - dow(today) + 7) % 7) || 7), 1];
  let m = /^(\d{1,2})[/-](\d{1,2})$/.exec(w);
  if (m) { const d = dayMonth(today, Number(m[1]), Number(m[2])); if (d) return [d, 1]; }
  m = /^(\d{1,2})(st|nd|rd|th)?$/.exec(w);
  const mi = MONTHS.indexOf(w2.slice(0, 3));
  if (m && mi >= 0) { const d = dayMonth(today, Number(m[1]), mi + 1); if (d) return [d, 2]; }
  const mi1 = MONTHS.indexOf(w.slice(0, 3));
  const m2 = /^(\d{1,2})(st|nd|rd|th)?$/.exec(w2);
  if (mi1 >= 0 && w.length <= 9 && m2) { const d = dayMonth(today, Number(m2[1]), mi1 + 1); if (d) return [d, 2]; }
  return null;
}

const PRIO: Record<string, QuickPriority> = { '!': 'high', '!!': 'high', '!!!': 'urgent', '!low': 'low', '!normal': 'normal', '!high': 'high', '!urgent': 'urgent', '!u': 'urgent', '!h': 'high', '!l': 'low' };

export function parseQuickTask(input: string, opts: { today: string; people: QuickPerson[]; me?: QuickPerson | null }): QuickParse {
  const words = input.trim().split(/\s+/).filter(Boolean);
  const keep: string[] = [];
  const out: QuickParse = { title: '', actBy: null, priority: 'normal', assignee: null, clientQuery: null, tokens: [] };
  for (let i = 0; i < words.length;) {
    const w = words[i]!;
    const lw = w.toLowerCase();
    if (PRIO[lw]) { out.priority = PRIO[lw]!; out.tokens.push({ kind: 'priority', text: out.priority }); i += 1; continue; }
    if (lw.startsWith('@') && lw.length > 1) {
      const q = lw.slice(1);
      const p = q === 'me' ? opts.me ?? null
        : opts.people.find((x) => x.name.toLowerCase().split(/\s+/).some((part) => part.startsWith(q))) ?? null;
      if (p) { out.assignee = p; out.tokens.push({ kind: 'person', text: p.name }); i += 1; continue; }
    }
    if (lw.startsWith('#') && lw.length > 1) { out.clientQuery = w.slice(1).replace(/[-_]/g, ' '); out.tokens.push({ kind: 'client', text: out.clientQuery }); i += 1; continue; }
    // Dates only when introduced naturally ("by"/"on"/"due" optional) and not already set.
    if (!out.actBy) {
      const intro = ['by', 'on', 'due'].includes(lw) ? 1 : 0;
      const hit = dateAt(words.slice(i + intro), opts.today);
      if (hit) { out.actBy = hit[0]; out.tokens.push({ kind: 'date', text: hit[0] }); i += intro + hit[1]; continue; }
    }
    keep.push(w); i += 1;
  }
  out.title = keep.join(' ').replace(/\s+([,.])/g, '$1').trim();
  return out;
}
