import { normalizePhone } from './clients';

/** Digits with country code: 10-digit Indian numbers get 91 prepended. */
export function internationalDigits(raw: string): string {
  const d = normalizePhone(raw);
  return d.length === 10 ? `91${d}` : d;
}
export function telLink(raw: string): string | null {
  const d = internationalDigits(raw);
  return d.length >= 6 ? `tel:+${d}` : null;
}
export function whatsappLink(raw: string, text?: string): string | null {
  const d = internationalDigits(raw);
  if (d.length < 10) return null;
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}
