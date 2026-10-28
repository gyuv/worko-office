import type { RulePack } from '@worko/rules';

export type DefaultService = {
  key: string; name: string; category: string; frequency: 'monthly' | 'quarterly' | 'annual' | 'one_time' | 'event';
  ruleId: string | null; slaDays: number; checks: Array<{ key: string; label: string; required: boolean }>; billable: boolean;
};

/** Working steps (not statutory data): firms edit these per service. */
const CHECKS: Record<string, Array<[string, string, boolean]>> = {
  GSTR1: [['sales_data', 'Sales register received', true], ['einv_reco', 'E-invoice / e-way bill reconciled', false], ['prepared', 'Return prepared', true], ['reviewed', 'Reviewed', true], ['filed', 'Filed (EVC/DSC)', true], ['ack', 'Acknowledgement saved', true]],
  GSTR3B: [['purchase_data', 'Purchase data received', true], ['itc_reco', 'ITC reconciled with GSTR-2B', true], ['tax_computed', 'Tax computed & shared with client', true], ['challan', 'Challan paid', true], ['filed', 'Filed', true], ['ack', 'Acknowledgement saved', true]],
  TDS_DEPOSIT: [['computed', 'TDS computed', true], ['challan', 'Challan paid', true], ['receipt', 'Challan receipt saved', true]],
  TDS_RETURN: [['data', 'Deduction data received', true], ['fvu', 'FVU generated', true], ['filed', 'Filed', true], ['ack', 'Token / acknowledgement saved', true]],
  ITR: [['docs', 'Documents received (AIS/26AS/Form 16)', true], ['computation', 'Computation prepared', true], ['approved', 'Client approved computation', true], ['filed', 'Filed', true], ['everified', 'E-verified', true]],
};
const GENERIC: Array<[string, string, boolean]> = [['data', 'Data received', true], ['prepared', 'Prepared', true], ['reviewed', 'Reviewed', false], ['filed', 'Filed / submitted', true], ['ack', 'Acknowledgement saved', false]];
const CATEGORY: Record<string, string> = { GST: 'GST', INCOME_TAX: 'Income tax', TDS: 'TDS', ROC: 'ROC', LLP: 'ROC', PF: 'Payroll', ESI: 'Payroll', PT: 'Payroll', FEMA: 'FEMA', SEBI: 'Other', OTHER: 'Other' };
const SLA: Record<string, number> = { monthly: 3, quarterly: 7, annual: 15 };

/**
 * Default catalogue: one service per `serviceTypeKey` in the active rule pack (names/frequency from the rules),
 * plus a few non-statutory services. No prices — billing rates are separate data (M7).
 */
export function defaultCatalogue(pack: RulePack): DefaultService[] {
  const byKey = new Map<string, RulePack['rules']>();
  for (const r of pack.rules) if (r.serviceTypeKey) byKey.set(r.serviceTypeKey, [...(byKey.get(r.serviceTypeKey) ?? []), r]);
  const out: DefaultService[] = [];
  for (const [key, rules] of byKey) {
    const first = rules[0]!;
    const ids = [...new Set(rules.map((r) => r.id))];
    out.push({
      key, name: ids.length > 1 ? first.form.replace(/\s*\(.*\)$/, '') : first.title, category: CATEGORY[first.regime] ?? 'Other',
      frequency: first.frequency === 'event' ? 'event' : first.frequency, ruleId: ids.length === 1 ? ids[0]! : null,
      slaDays: SLA[first.frequency] ?? 5, billable: true,
      checks: (CHECKS[key] ?? GENERIC).map(([k, label, required]) => ({ key: k, label, required })),
    });
  }
  out.push(
    { key: 'BOOKKEEPING', name: 'Bookkeeping', category: 'Accounting', frequency: 'monthly', ruleId: null, slaDays: 0, billable: true,
      checks: [['vouchers', 'Vouchers entered', true], ['bank_reco', 'Bank reconciled', true], ['reviewed', 'Reviewed', false]].map(([k, l, r]) => ({ key: k as string, label: l as string, required: r as boolean })) },
    { key: 'CONSULTATION', name: 'Consultation / advisory', category: 'Advisory', frequency: 'event', ruleId: null, slaDays: 0, billable: true, checks: [] },
  );
  return out;
}
