import Anthropic from '@anthropic-ai/sdk';
import { parseNoticeText, type AiFeature } from '@worko/domain';

/** One model call. `user` already holds redacted text in delimited <data> blocks (built by AiService, never by callers). */
export type AiRequest = { feature: AiFeature; system: string; user: string; maxTokens: number };
export type AiResponse = { text: string; inputTokens: number; outputTokens: number; model: string; refused?: boolean };

/** Provider adapter (M21). Selected by `AI_PROVIDER` (mock default). Every call goes through AiService (gate → redact → meter). */
export interface AiProvider {
  readonly name: string;
  /** True when content leaves the system (always needs the firm's opt-in). */
  readonly external: boolean;
  readonly model: string;
  complete(r: AiRequest): Promise<AiResponse>;
}
export const AI_PROVIDER = 'AI_PROVIDER';

const dataOf = (user: string) => [...user.matchAll(/<data[^>]*>\n([\s\S]*?)\n<\/data>/g)].map((m) => m[1]!).join('\n');
const tokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Deterministic mock (tests, dev, the demo — clearly labelled "mock" in every suggestion). It records each request
 * so tests can assert what would have left the system. `MOCK_ECHO:` inside data simulates a model that obeys an
 * injected instruction: the rest of that line becomes the raw reply (the strict parsers must then drop it).
 */
export class MockAiProvider implements AiProvider {
  readonly name = 'mock';
  readonly external = false;
  readonly model = 'mock-1';
  readonly calls: AiRequest[] = [];
  async complete(r: AiRequest): Promise<AiResponse> {
    this.calls.push(r);
    const data = dataOf(r.user);
    const echo = /MOCK_ECHO:(.*)/.exec(data);
    const text = echo ? echo[1]!.trim() : JSON.stringify(this.answer(r.feature, data));
    return { text, inputTokens: tokens(r.system) + tokens(r.user), outputTokens: tokens(text), model: this.model };
  }
  private answer(f: AiFeature, data: string): unknown {
    const name = /\[CLIENT_\d+\]/.exec(data)?.[0] ?? 'Sir/Madam';
    switch (f) {
      case 'notice_extraction': return { suggestions: parseNoticeText(data).map((s) => ({ ...s, confidence: Math.min(s.confidence, 0.9) })) };
      case 'draft_reply': case 'automation_draft':
        return { subject: 'Re: your message', body: `Dear ${name},\n\nThank you for writing to us. We have noted your message and will get back to you shortly.\n\nRegards` };
      case 'summarise': {
        const lines = data.split('\n').map((l) => l.trim()).filter(Boolean);
        return { summary: `${lines.length} recent item(s) reviewed for ${name}.`, points: lines.slice(0, 3).map((l) => l.slice(0, 120)) };
      }
      case 'classify_upload': {
        const t = data.toLowerCase();
        const category = /gstr|gst/.test(t) ? 'GST' : /bank|statement/.test(t) ? 'Bank statements' : /form\s?16|26as|ais|itr/.test(t) ? 'Income tax' : /invoice|sales/.test(t) ? 'Sales invoices' : 'General';
        const fy = /\b(20\d{2})-(\d{2})\b/.exec(data);
        return { category, fy: fy ? `${fy[1]}-${fy[2]}` : null, confidence: category === 'General' ? 0.3 : 0.8 };
      }
      case 'nl_query': return { definition: mockNlDefinition(data) };
      default: return { answer: 'Not available in mock mode.' };
    }
  }
}

/**
 * Deterministic NL → report definition for the mock (M21 NL query). Handles the PRD example "unbilled GST work FY 25-26 by
 * user" and a few common shapes; it only ever sees the (redacted) question — never data rows.
 */
export function mockNlDefinition(question: string): Record<string, unknown> {
  const q = question.toLowerCase();
  const ds = /salar|cost rate|\bcost\b/.test(q) ? 'time_entries' : /unbilled|not billed|to bill/.test(q) ? 'unbilled' : /overdue|late task/.test(q) ? 'tasks'
    : /ageing|aging|outstanding|receivable/.test(q) ? 'ageing' : /collection|receipt|collected/.test(q) ? 'receipts' : /notice/.test(q) ? 'notices' : /lead/.test(q) ? 'leads'
      : /time|hours/.test(q) ? 'time_entries' : 'tasks';
  const dateCol: Record<string, string> = { unbilled: 'completedOn', tasks: 'statutoryDue', receipts: 'receivedOn', time_entries: 'workDate', notices: 'receivedOn' };
  const userCol: Record<string, string> = { unbilled: 'assigneeName', tasks: 'assigneeName', time_entries: 'userName', notices: 'assigneeName', leads: 'ownerName' };
  const filters: Array<Record<string, unknown>> = [];
  if (/\bgst\b/.test(q) && ['unbilled', 'tasks'].includes(ds)) filters.push({ column: 'serviceCategory', op: 'eq', value: 'GST' });
  if (ds === 'tasks' && /overdue/.test(q)) filters.push({ column: 'overdue', op: 'eq', value: true });
  const fy = /\bfy\s*(\d{2,4}\s*-\s*\d{2,4})/.exec(q);
  if (fy && dateCol[ds]) filters.push({ column: dateCol[ds], op: 'fy', value: fy[1]!.replace(/\s+/g, '') });
  const groupBy = /\bby (user|assignee|person|staff|employee|people)/.test(q) || /salar/.test(q) ? [userCol[ds] ?? 'clientName'].filter(Boolean)
    : /\bby client/.test(q) ? ['clientName'] : /\bby service/.test(q) && ['unbilled', 'tasks'].includes(ds) ? ['serviceName'] : [];
  const money: Record<string, string> = { unbilled: 'suggestedPaise', receipts: 'amountPaise', ageing: 'balancePaise', notices: 'demandPaise', leads: 'expectedValuePaise' };
  const aggregates: Array<Record<string, unknown>> = [{ fn: 'count' }];
  if (money[ds]) aggregates.push({ fn: 'sum', column: money[ds] });
  if (ds === 'time_entries') aggregates.push({ fn: 'sum', column: 'minutes' }, { fn: 'sum', column: 'costPaise' });
  const columns: Record<string, string[]> = { unbilled: ['clientName', 'title', 'serviceName', 'assigneeName', 'completedOn', 'suggestedPaise'], tasks: ['title', 'clientName', 'assigneeName', 'statutoryDue', 'status'],
    time_entries: ['userName', 'workDate', 'clientName', 'minutes', 'costPaise'], ageing: ['clientName', 'bucket', 'balancePaise'], receipts: ['receivedOn', 'clientName', 'amountPaise'],
    notices: ['title', 'clientName', 'authority', 'receivedOn', 'demandPaise'], leads: ['name', 'stage', 'ownerName', 'expectedValuePaise'] };
  if (ds === 'ageing' && !groupBy.length) groupBy.push('bucket');
  return { dataset: ds, columns: columns[ds], filters, groupBy, aggregates, chart: { type: groupBy.length ? 'bar' : 'table' } };
}

/**
 * Anthropic via @anthropic-ai/sdk (AI_PROVIDER=anthropic + ANTHROPIC_API_KEY; model from AI_MODEL). Receives redacted text only,
 * never files. // VERIFY AGAINST OFFICIAL DOCS: model ids, token limits, pricing (ai_rate table), data-retention terms.
 */
export class AnthropicAiProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly external = true;
  readonly model = process.env.AI_MODEL || 'claude-opus-5-5';
  private client = new Anthropic();
  async complete(r: AiRequest): Promise<AiResponse> {
    const res = await this.client.messages.create({ model: this.model, max_tokens: r.maxTokens, output_config: { effort: 'low' }, system: r.system, messages: [{ role: 'user', content: r.user }] });
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, model: res.model, refused: res.stop_reason === 'refusal' };
  }
}

export function aiProviderFactory(): AiProvider {
  const want = process.env.AI_PROVIDER ?? (process.env.NOTICE_EXTRACTOR === 'anthropic' ? 'anthropic' : 'mock');
  if (want === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY');
    return new AnthropicAiProvider();
  }
  if (want !== 'mock') throw new Error(`Unknown AI_PROVIDER ${want}`);
  return new MockAiProvider();
}
/** `AI_DISABLED=1` = no-AI mode for the whole deployment, whatever firms chose. */
export const envNoAi = () => ['1', 'true', 'yes'].includes(String(process.env.AI_DISABLED ?? '').toLowerCase());
