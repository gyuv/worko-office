import { ForbiddenException } from '@nestjs/common';
import type { RequestActor } from './context.js';

/** Sensitive reveals need a recent step-up on this very session. */
export function requireElevated(a: RequestActor, now = new Date()) {
  if (!a.elevatedUntil || a.elevatedUntil <= now) throw new ForbiddenException({ code: 'STEP_UP_REQUIRED', message: 'Confirm your password or authenticator code to continue' });
}
