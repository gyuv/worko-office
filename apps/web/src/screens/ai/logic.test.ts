import { describe, expect, it } from 'vitest';
import { aiButtonVisible, approveBody, editableOf, editErrors, redactedPreview, suggestionActions, type AiAvailability } from './logic';

const avail = (o: Partial<AiAvailability> = {}): AiAvailability => ({ noAiMode: false, features: { summarise: 'ok', draft_reply: 'feature_disabled' }, firmCapReached: false, userCapReached: false, mock: true, ...o });

describe('AI button visibility', () => {
  it('needs ai:create and an ok gate', () => {
    expect(aiButtonVisible({ canCreate: true, availability: avail(), feature: 'summarise' })).toBe(true);
    expect(aiButtonVisible({ canCreate: false, availability: avail(), feature: 'summarise' })).toBe(false);
    expect(aiButtonVisible({ canCreate: true, availability: avail(), feature: 'draft_reply' })).toBe(false);
    expect(aiButtonVisible({ canCreate: true, availability: avail({ features: { summarise: 'ai_disabled' } }), feature: 'summarise' })).toBe(false);
  });
  it('hidden in no-AI mode, when a budget is used up, or when unknown', () => {
    expect(aiButtonVisible({ canCreate: true, availability: avail({ noAiMode: true }), feature: 'summarise' })).toBe(false);
    expect(aiButtonVisible({ canCreate: true, availability: avail({ userCapReached: true }), feature: 'summarise' })).toBe(false);
    expect(aiButtonVisible({ canCreate: true, availability: undefined, feature: 'summarise' })).toBe(false);
  });
});

describe('suggestion state/actions', () => {
  const s = { status: 'pending' as const, kind: 'draft_reply' as const, purged: false, payload: { subject: 'Re: notice', body: 'Dear sir', channel: 'email' } };
  it('pending drafts can be edited, approved, rejected; decided ones nothing; purged only rejected', () => {
    expect(suggestionActions(s)).toEqual(['edit', 'approve', 'reject']);
    expect(suggestionActions({ ...s, kind: 'esign_request' })).toEqual(['approve', 'reject']);
    expect(suggestionActions({ ...s, status: 'approved' })).toEqual([]);
    expect(suggestionActions({ ...s, purged: true, payload: null })).toEqual(['reject']);
  });
  it('approve body carries only edited fields', () => {
    const e = editableOf(s);
    expect(approveBody(s, e)).toEqual({});
    expect(approveBody(s, { ...e, body: 'Dear sir, edited' })).toEqual({ body: 'Dear sir, edited' });
    const c = { kind: 'classification' as const, payload: { category: 'gst', fy: '2025-26' } };
    expect(approveBody(c, { ...editableOf(c), fy: '' })).toEqual({ fy: null });
    expect(editErrors('classification', { subject: '', body: '', category: '', fy: '25' })).toEqual({ category: 'required', fy: 'fy' });
    expect(editErrors('draft_reply', { subject: '', body: ' ', category: '', fy: '' })).toEqual({ body: 'required' });
  });
  it('redacted preview hides identifiers and client names', () => {
    const r = redactedPreview('Mehta Traders PAN ABCPM1234K, call 9876543210, mail a@b.in', ['Mehta Traders']);
    expect(r).toBe('[CLIENT_1] PAN [PAN_1], call [PHONE_1], mail [EMAIL_1]');
  });
});
