import Anthropic from '@anthropic-ai/sdk';
import { parseNoticeText, type FieldSuggestion } from '@worko/domain';

/**
 * "AI drafts fields; I confirm" (M7). An extractor turns a notice's text into field suggestions with confidence.
 * Suggestions are stored apart from the notice and applied only to fields a user confirms (D113).
 */
export interface NoticeExtractor {
  readonly name: string;
  /** True when it sends content outside the system (requires the firm's opt-in). */
  readonly external: boolean;
  extract(text: string): Promise<FieldSuggestion[]>;
}

/** Deterministic regex extractor over the text layer — the default and the fallback. */
export class MockNoticeExtractor implements NoticeExtractor {
  readonly name = 'mock';
  readonly external = false;
  async extract(text: string) { return parseNoticeText(text); }
}

const FIELDS = ['authority', 'section', 'din', 'referenceNo', 'assessmentYear', 'financialYear', 'issueDate', 'responseDue', 'demandPaise', 'pan', 'gstin'];

/**
 * Anthropic SKELETON (off by default: NOTICE_EXTRACTOR=anthropic + ANTHROPIC_API_KEY + the firm's `ai.noticeExtraction` opt-in).
 * Sends only the extracted text (never the file), PAN/GSTIN-like identifiers are masked first, and the answer is validated
 * against the field list — anything else is dropped. // VERIFY AGAINST OFFICIAL DOCS (structured output shape, data retention terms).
 */
export class AnthropicNoticeExtractor implements NoticeExtractor {
  readonly name = 'anthropic';
  readonly external = true;
  private client = new Anthropic();
  private model = process.env.AI_MODEL || 'claude-opus-5-5';
  async extract(text: string): Promise<FieldSuggestion[]> {
    const redacted = text.slice(0, 50_000).replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, '[PAN]').replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, '[GSTIN]').replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '[ID]');
    const res = await this.client.messages.create({
      model: this.model, max_tokens: 4000, output_config: { effort: 'low' },
      system: `You extract fields from Indian tax/regulatory notices. Reply with JSON only: {"suggestions":[{"field":one of ${JSON.stringify(FIELDS)},"value":string|number,"confidence":0..1,"source":short quote}]}. Dates as YYYY-MM-DD; demandPaise in paise. Omit fields you cannot find.`,
      messages: [{ role: 'user', content: redacted }],
    });
    if (res.stop_reason === 'refusal') return [];
    const body = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    try {
      const j = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)) as { suggestions?: FieldSuggestion[] };
      return (j.suggestions ?? []).filter((s) => FIELDS.includes(s.field) && ['string', 'number'].includes(typeof s.value))
        .map((s) => ({ field: s.field, value: s.value, confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0)), source: String(s.source ?? '').slice(0, 120) }));
    } catch { return []; }
  }
}

export const NOTICE_EXTRACTORS = 'NOTICE_EXTRACTORS';
export const noticeExtractorsFactory = (): Record<string, NoticeExtractor> => {
  const out: Record<string, NoticeExtractor> = { mock: new MockNoticeExtractor() };
  if (process.env.NOTICE_EXTRACTOR === 'anthropic' && process.env.ANTHROPIC_API_KEY) out.anthropic = new AnthropicNoticeExtractor();
  return out;
};

/**
 * Text layer of an upload: plain text as-is; for PDFs, literal strings of uncompressed content streams (`(…) Tj`).
 * Compressed/scanned PDFs yield '' (no OCR here — KNOWN_GAPS).
 */
export function textOf(buf: Buffer, mime: string): string {
  if (mime.startsWith('text/')) return buf.toString('utf8');
  if (mime !== 'application/pdf') return '';
  const s = buf.toString('latin1');
  const out: string[] = [];
  const rx = /\(((?:\\.|[^\\)])*)\)\s*Tj|\[((?:\([^)]*\)|[^\]])*)\]\s*TJ/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s)) && out.length < 20_000) {
    const raw = m[1] ?? (m[2] ?? '').match(/\(((?:\\.|[^\\)])*)\)/g)?.map((x) => x.slice(1, -1)).join('') ?? '';
    out.push(raw.replace(/\\([()\\])/g, '$1').replace(/\\n/g, '\n'));
  }
  return out.join('\n');
}
