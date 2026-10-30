import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { passwordIssues } from '@worko/domain';
import { createHash } from 'node:crypto';

/**
 * Breached-password lookup by k-anonymity: only the first 5 hex chars of SHA-1(password) leave the server; the
 * provider returns the suffixes it knows for that range and we compare locally (D198).
 */
export interface BreachedPasswordProvider { readonly name: string; range(prefix5: string): Promise<string[]> }
export const BREACHED_PASSWORDS = 'BREACHED_PASSWORDS';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').toUpperCase();
/** Deterministic mock: a small list of very common passwords (dev/tests; no network). */
export class MockBreachedPasswords implements BreachedPasswordProvider {
  readonly name = 'mock';
  private readonly hashes = ['password123', 'Password@123', 'qwerty12345', 'iloveyou123', 'welcome@123', 'Admin@12345', 'india@12345', 'P@ssw0rd123'].map(sha1);
  async range(prefix5: string) { return this.hashes.filter((h) => h.startsWith(prefix5)).map((h) => h.slice(5)); }
}
/** VERIFY AGAINST OFFICIAL DOCS: Have I Been Pwned range API (`GET https://api.pwnedpasswords.com/range/{prefix}`, lines `SUFFIX:COUNT`, Add-Padding header). */
export class HibpBreachedPasswords implements BreachedPasswordProvider {
  readonly name = 'hibp';
  async range(prefix5: string) {
    const r = await fetch(`https://api.pwnedpasswords.com/range/${prefix5}`, { headers: { 'Add-Padding': 'true', 'User-Agent': 'Worko' }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`hibp ${r.status}`);
    return (await r.text()).split('\n').map((l) => l.split(':')).filter(([, n]) => Number(n) > 0).map(([s]) => s!.trim());
  }
}
export const breachedPasswordsFactory = (): BreachedPasswordProvider => process.env.BREACHED_PASSWORD_CHECK === 'hibp' ? new HibpBreachedPasswords() : new MockBreachedPasswords();

@Injectable()
export class PasswordPolicyService {
  private log = new Logger('PasswordPolicy');
  constructor(@Inject(BREACHED_PASSWORDS) private breached: BreachedPasswordProvider) {}

  /** 400 WEAK_PASSWORD (local rules) or BREACHED_PASSWORD. The lookup fails open (logged) so an outage can't block onboarding. */
  async assert(pw: string, ctx: { email?: string | null; name?: string | null } = {}) {
    const issues = passwordIssues(pw, ctx);
    if (issues.length) throw new BadRequestException({ code: 'WEAK_PASSWORD', message: 'Choose a stronger password', issues });
    const h = sha1(pw);
    let suffixes: string[];
    try { suffixes = await this.breached.range(h.slice(0, 5)); } catch (e) { this.log.warn(`breached-password check unavailable (${this.breached.name}): ${(e as Error).message}`); return; }
    if (suffixes.includes(h.slice(5))) throw new BadRequestException({ code: 'BREACHED_PASSWORD', message: 'This password appears in known data breaches — choose another' });
  }
}
