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

// The external-model path now goes through the AI layer (`AiService.extractNotice`: opt-in gate, redaction, metering — D150);
// this local regex extractor stays the default and the fallback, and needs no opt-in because nothing leaves the system.

export const NOTICE_EXTRACTORS = 'NOTICE_EXTRACTORS';
export const noticeExtractorsFactory = (): Record<string, NoticeExtractor> => {
  return { mock: new MockNoticeExtractor() };
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
