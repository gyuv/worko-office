import { Injectable } from '@nestjs/common';

/** Injectable "now" for business-date rules (issue date ≤ today IST, follow-up asOf); tests and the demo seed pin it. */
@Injectable()
export class Clock {
  private fixed: Date | null = null;
  constructor(fixed?: Date) { this.fixed = fixed ?? null; }
  now(): Date { return this.fixed ? new Date(this.fixed) : new Date(); }
  /** Test/seed hook: pin the clock (null = wall clock). */
  set(at: Date | null) { this.fixed = at; }
  /** Today's date in IST, yyyy-mm-dd. */
  todayIst(): string { return new Date(this.now().getTime() + 330 * 60_000).toISOString().slice(0, 10); }
}
