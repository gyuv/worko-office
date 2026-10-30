import type { LoggerService } from '@nestjs/common';
import { redact } from '@worko/domain';

/** Masks PAN/GSTIN/Aadhaar/phone/e-mail/bank numbers etc. (the AI redactor's patterns) in any log text — D199. */
export const redactLog = (s: string) => redact(s).text;

type Level = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';
/**
 * Structured JSON-lines logger with PII redaction. Every message (and stack) passes through `redactLog`, so a stray
 * PAN or phone number in an error never reaches log storage. Installed for the whole app by `applyHttpHardening`.
 */
export class RedactingLogger implements LoggerService {
  constructor(private write: (line: string) => void = (l) => process.stdout.write(l + '\n'), private levels: Level[] = ['log', 'error', 'warn', 'fatal']) {}
  private out(level: Level, message: unknown, rest: unknown[]) {
    if (!this.levels.includes(level)) return;
    const ctx = rest.length && typeof rest[rest.length - 1] === 'string' ? rest[rest.length - 1] as string : undefined;
    const stack = level === 'error' && rest.length > 1 && typeof rest[0] === 'string' ? rest[0] : undefined;
    const msg = typeof message === 'string' ? message : message instanceof Error ? message.message : JSON.stringify(message);
    this.write(JSON.stringify({ at: new Date().toISOString(), level, ctx, msg: redactLog(msg ?? ''), ...(stack ? { stack: redactLog(stack) } : {}) }));
  }
  log(m: unknown, ...r: unknown[]) { this.out('log', m, r); }
  error(m: unknown, ...r: unknown[]) { this.out('error', m, r); }
  warn(m: unknown, ...r: unknown[]) { this.out('warn', m, r); }
  debug(m: unknown, ...r: unknown[]) { this.out('debug', m, r); }
  verbose(m: unknown, ...r: unknown[]) { this.out('verbose', m, r); }
  fatal(m: unknown, ...r: unknown[]) { this.out('fatal', m, r); }
}
