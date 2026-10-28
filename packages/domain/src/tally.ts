import type { Paise } from './money.js';

/**
 * Tally XML voucher generation (M18). Pure: the desktop connector posts the result to Tally's local HTTP port.
 *
 * // VERIFY AGAINST OFFICIAL DOCS (Tally integration / XML import): the envelope, tag names, the sign convention
 * (debits negative with ISDEEMEDPOSITIVE=Yes) and date format (YYYYMMDD) follow commonly published samples and
 * have not been verified against a live Tally Prime install. See docs/KNOWN_GAPS.md.
 */

/** Our side of the ledger mapping. `party:<clientId>` and `sales:<SERVICEKEY>` are optional overrides. */
export const TALLY_ACCOUNTS = ['sales', 'output_cgst', 'output_sgst', 'output_igst', 'round_off', 'reimbursement', 'tds_receivable', 'bank', 'cash'] as const;
export type TallyAccount = (typeof TALLY_ACCOUNTS)[number];

export type TallyEntry = { account: string; amountPaise: Paise; debit: boolean };
export type TallyVoucher = {
  id: string; type: 'Sales' | 'Receipt' | 'Credit Note' | 'Debit Note'; number: string; date: string; // yyyy-mm-dd
  partyAccount: string; partyFallbackName: string; narration?: string; entries: TallyEntry[];
};
export type TallyError = { voucherId: string; voucherNumber: string; code: 'unmapped_ledger' | 'unbalanced'; account?: string };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const amt = (p: Paise) => `${p < 0 ? '-' : ''}${Math.floor(Math.abs(p) / 100)}.${String(Math.abs(p) % 100).padStart(2, '0')}`;

/** Resolves an account to a Tally ledger name: exact key first, then its generic prefix (`sales:GSTR3B` → `sales`). */
export function resolveLedger(map: Record<string, string>, account: string): string | null {
  if (map[account]) return map[account]!;
  const base = account.split(':')[0]!;
  return base !== account && map[base] ? map[base]! : null;
}

/**
 * Builds the import envelope. Every voucher must balance (Σdebits = Σcredits) and every ledger must be mapped,
 * except party ledgers, which default to the client's name. Returns errors instead of XML for bad vouchers.
 */
export function buildTallyXml(company: string, vouchers: TallyVoucher[], map: Record<string, string>): { xml: string; errors: TallyError[]; count: number } {
  const errors: TallyError[] = [];
  const parts: string[] = [];
  for (const v of vouchers) {
    const before = errors.length;
    const dr = v.entries.filter((e) => e.debit).reduce((s, e) => s + e.amountPaise, 0);
    const cr = v.entries.filter((e) => !e.debit).reduce((s, e) => s + e.amountPaise, 0);
    if (dr !== cr) errors.push({ voucherId: v.id, voucherNumber: v.number, code: 'unbalanced' });
    const party = resolveLedger(map, v.partyAccount) ?? v.partyFallbackName;
    const lines: string[] = [];
    for (const e of v.entries) {
      if (e.amountPaise === 0) continue;
      const ledger = e.account === v.partyAccount ? party : resolveLedger(map, e.account);
      if (!ledger) { errors.push({ voucherId: v.id, voucherNumber: v.number, code: 'unmapped_ledger', account: e.account }); continue; }
      lines.push(`<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${e.debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${amt(e.debit ? -e.amountPaise : e.amountPaise)}</AMOUNT></ALLLEDGERENTRIES.LIST>`);
    }
    if (errors.length > before) continue;
    parts.push(`<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${esc(v.type)}" ACTION="Create"><DATE>${v.date.replace(/-/g, '')}</DATE>`
      + `<GUID>worko-${esc(v.id)}</GUID><VOUCHERTYPENAME>${esc(v.type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(v.number)}</VOUCHERNUMBER>`
      + `<PARTYLEDGERNAME>${esc(party)}</PARTYLEDGERNAME>${v.narration ? `<NARRATION>${esc(v.narration)}</NARRATION>` : ''}${lines.join('')}</VOUCHER></TALLYMESSAGE>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>`
    + `<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>`
    + `<REQUESTDATA>${parts.join('')}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`;
  return { xml, errors, count: parts.length };
}

/** Sales voucher for an issued invoice (debit note uses the same shape; a credit note reverses it). */
export function invoiceVoucher(i: {
  id: string; kind: 'invoice' | 'credit_note' | 'debit_note'; number: string; date: string; clientId: string; clientName: string;
  lines: Array<{ serviceKey: string | null; taxablePaise: Paise; reimbursement: boolean; totalPaise: Paise }>;
  cgstPaise: Paise; sgstPaise: Paise; igstPaise: Paise; roundOffPaise: Paise; totalPaise: Paise;
}): TallyVoucher {
  const credit = i.kind !== 'credit_note'; // revenue side is a credit on a sale, a debit on a credit note
  const entries: TallyEntry[] = [{ account: `party:${i.clientId}`, amountPaise: i.totalPaise, debit: credit }];
  for (const l of i.lines) {
    if (l.reimbursement) entries.push({ account: 'reimbursement', amountPaise: l.totalPaise, debit: !credit });
    else entries.push({ account: l.serviceKey ? `sales:${l.serviceKey}` : 'sales', amountPaise: l.taxablePaise, debit: !credit });
  }
  entries.push({ account: 'output_cgst', amountPaise: i.cgstPaise, debit: !credit }, { account: 'output_sgst', amountPaise: i.sgstPaise, debit: !credit },
    { account: 'output_igst', amountPaise: i.igstPaise, debit: !credit });
  if (i.roundOffPaise) entries.push({ account: 'round_off', amountPaise: Math.abs(i.roundOffPaise), debit: i.roundOffPaise > 0 ? !credit : credit });
  return { id: i.id, type: i.kind === 'invoice' ? 'Sales' : i.kind === 'credit_note' ? 'Credit Note' : 'Debit Note', number: i.number, date: i.date,
    partyAccount: `party:${i.clientId}`, partyFallbackName: i.clientName, entries: merge(entries) };
}

/** Receipt voucher: Dr bank/cash (+ TDS receivable), Cr party. */
export function receiptVoucher(r: { id: string; number: string; date: string; clientId: string; clientName: string; mode: string; amountPaise: Paise; tdsPaise: Paise; reference?: string | null }): TallyVoucher {
  return {
    id: r.id, type: 'Receipt', number: r.number, date: r.date, partyAccount: `party:${r.clientId}`, partyFallbackName: r.clientName,
    narration: r.reference ? `Ref ${r.reference}` : undefined,
    entries: [
      { account: r.mode === 'cash' ? 'cash' : 'bank', amountPaise: r.amountPaise, debit: true },
      { account: 'tds_receivable', amountPaise: r.tdsPaise, debit: true },
      { account: `party:${r.clientId}`, amountPaise: r.amountPaise + r.tdsPaise, debit: false },
    ].filter((e) => e.amountPaise > 0),
  };
}

/** Same account and side → one ledger line. */
function merge(es: TallyEntry[]): TallyEntry[] {
  const m = new Map<string, TallyEntry>();
  for (const e of es) {
    if (!e.amountPaise) continue;
    const k = `${e.account}|${e.debit}`;
    const cur = m.get(k);
    m.set(k, cur ? { ...cur, amountPaise: cur.amountPaise + e.amountPaise } : { ...e });
  }
  return [...m.values()];
}
