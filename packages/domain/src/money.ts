/** Money is always integer paise to avoid float errors. */
export type Paise = number;

export const rupeesToPaise = (r: number): Paise => Math.round(r * 100);

/** Indian grouping: 12,34,56,789.00 */
export function formatINR(paise: Paise, opts: { symbol?: boolean } = {}): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100).toString();
  const p = (abs % 100).toString().padStart(2, '0');
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return `${neg ? '-' : ''}${opts.symbol === false ? '' : '₹'}${grouped}.${p}`;
}

/** Compact lakh/crore: 1.25 Cr, 3.4 L */
export function formatCompactINR(paise: Paise): string {
  const r = paise / 100;
  const a = Math.abs(r);
  if (a >= 1e7) return `₹${+(r / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `₹${+(r / 1e5).toFixed(2)} L`;
  return formatINR(paise);
}

export type GstSplit = { cgst: Paise; sgst: Paise; igst: Paise };

/** Place-of-supply rule: same state → CGST+SGST, else IGST. Rate in percent. */
export function splitGst(taxable: Paise, ratePct: number, supplierState: string, posState: string): GstSplit {
  const tax = Math.round((taxable * ratePct) / 100);
  if (supplierState === posState) {
    const half = Math.floor(tax / 2);
    return { cgst: half, sgst: tax - half, igst: 0 };
  }
  return { cgst: 0, sgst: 0, igst: tax };
}
