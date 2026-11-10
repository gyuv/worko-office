/** Normalises a typed server address ("worko-api.onrender.com" → https://worko-api.onrender.com/v1); null if unusable. */
export function normaliseServer(raw: string): string | null {
  const v = raw.trim();
  if (!v || (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) && !/^https?:\/\//i.test(v))) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|10\.0\.2\.2|192\.168\.)/.test(u.hostname))) return null;
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.origin}${path && path !== '' ? path : '/v1'}`;
  } catch { return null; }
}
