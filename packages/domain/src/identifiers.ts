import { z } from 'zod';

/** PAN: 5 letters, 4 digits, 1 letter. 4th char is holder type. */
export const PAN_REGEX = /^[A-Z]{3}[ABCFGHLJPTK][A-Z]\d{4}[A-Z]$/;
/** TAN: 4 letters, 5 digits, 1 letter. */
export const TAN_REGEX = /^[A-Z]{4}\d{5}[A-Z]$/;
/** GSTIN: 2-digit state + PAN + entity no + 'Z' (default) + checksum. */
export const GSTIN_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z][A-Z0-9][0-9A-Z]$/;
/** UDIN: 18 characters — 2-digit year + 6-digit membership no + 10 alphanumerics. Format check only. VERIFY AGAINST OFFICIAL DOCS. */
export const UDIN_REGEX = /^\d{8}[A-Z0-9]{10}$/;

const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Computes the GSTIN check character (mod-36 Luhn variant). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GST_CHARS.indexOf(first14[i]!);
    const prod = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  return GST_CHARS[(36 - (sum % 36)) % 36]!;
}

export function isValidGstin(g: string): boolean {
  const s = g.toUpperCase();
  return GSTIN_REGEX.test(s) && gstinCheckChar(s.slice(0, 14)) === s[14];
}

export const isValidPan = (p: string) => PAN_REGEX.test(p.toUpperCase());
export const isValidTan = (t: string) => TAN_REGEX.test(t.toUpperCase());
export const isValidUdin = (u: string) => UDIN_REGEX.test(u.toUpperCase());

/** PAN embedded in a GSTIN. */
export const panFromGstin = (g: string) => g.toUpperCase().slice(2, 12);

export function maskAadhaar(a: string): string {
  const d = a.replace(/\D/g, '');
  return d.length === 12 ? `XXXX XXXX ${d.slice(8)}` : 'XXXX XXXX XXXX';
}

export const panSchema = z.string().trim().toUpperCase().refine(isValidPan, 'Invalid PAN');
export const gstinSchema = z.string().trim().toUpperCase().refine(isValidGstin, 'Invalid GSTIN');
export const tanSchema = z.string().trim().toUpperCase().refine(isValidTan, 'Invalid TAN');
export const udinSchema = z.string().trim().toUpperCase().refine(isValidUdin, 'Invalid UDIN format');
