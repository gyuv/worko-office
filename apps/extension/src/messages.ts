import type { Portal } from '@worko/domain';

/** popup → background */
export type PopupRequest =
  | { type: 'status' }
  | { type: 'pair'; apiBase: string; firm: string; code: string }
  | { type: 'list'; q?: string }
  | { type: 'fill'; secretId: string }
  | { type: 'stepUp'; password?: string; totp?: string }
  | { type: 'signOut' };

export type SecretItem = { id: string; clientName: string; label: string; usernameHint: string; portal: Portal };

export type PopupResponse =
  | { ok: true; paired: boolean; apiBase: string; firm: string; portal: Portal | null }
  | { ok: true; secrets: SecretItem[] }
  | { ok: true; filled: number }
  | { ok: true }
  | { ok: false; needsStepUp?: boolean; signedOut?: boolean; error: string };

/** background → content script (top frame of one verified portal tab only). */
export type FillMessage = { type: 'worko:fill'; portal: Portal; username: string; password: string };
