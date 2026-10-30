/** Spec object as parsed from docs/openapi.yaml (only the parts the filter touches are typed). */
type Spec = { openapi: string; info: Record<string, unknown>; paths: Record<string, Record<string, { tags?: string[] } & Record<string, unknown>>>; components?: Record<string, Record<string, unknown>> } & Record<string, unknown>;

export const PUBLIC_TAG = 'public';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function refsIn(v: unknown, out: Set<string>) {
  if (Array.isArray(v)) v.forEach((x) => refsIn(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === '$ref' && typeof x === 'string') out.add(x); else refsIn(x, out); }
}

/**
 * The public API document = operations tagged `public`, plus only the components they reference (transitively),
 * with API-key bearer auth (D191). Generated from the single source of truth, docs/openapi.yaml.
 */
export function publicSpec(spec: Spec) {
  const paths: Spec['paths'] = {};
  for (const [p, ops] of Object.entries(spec.paths)) {
    const keep = Object.fromEntries(Object.entries(ops).filter(([m, op]) => METHODS.includes(m) && op.tags?.includes(PUBLIC_TAG))
      .map(([m, op]) => [m, { ...op, tags: (op.tags ?? []).filter((t) => t !== PUBLIC_TAG), security: [{ apiKey: [] }] }]));
    if (Object.keys(keep).length) paths[p] = keep;
  }
  const refs = new Set<string>();
  refsIn(paths, refs);
  const components: Record<string, Record<string, unknown>> = {};
  const queue = [...refs];
  while (queue.length) {
    const r = queue.pop()!;
    const m = /^#\/components\/(\w+)\/(.+)$/.exec(r);
    if (!m) continue;
    const def = spec.components?.[m[1]!]?.[m[2]!];
    if (def === undefined || components[m[1]!]?.[m[2]!] !== undefined) continue;
    (components[m[1]!] ??= {})[m[2]!] = def;
    const inner = new Set<string>(); refsIn(def, inner);
    for (const x of inner) if (!refs.has(x)) { refs.add(x); queue.push(x); }
  }
  components.securitySchemes = { apiKey: { type: 'http', scheme: 'bearer', description: 'Firm API key `wk_<prefix>_<secret>` (Settings → Developers).' } };
  const sorted = Object.fromEntries(Object.entries(components).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))]));
  return {
    openapi: spec.openapi,
    info: { title: 'Worko public API', version: 'v1', description: 'API-key access to a subset of the Worko API. Cursor pagination (`cursor`, `limit`, `nextCursor`), `Idempotency-Key` on POST/PATCH, errors `{ statusCode, message, code? }`. Webhooks: `Worko-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`.' },
    servers: [{ url: '/v1' }], security: [{ apiKey: [] }], paths, components: sorted,
  };
}
