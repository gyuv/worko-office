import { isPortalUrl, type Portal } from '@worko/domain';

export type LoginFields = { username: HTMLInputElement | null; password: HTMLInputElement | null };

const CAPTCHA = /captcha/i;

/** True if the input looks like a CAPTCHA box — those are never touched. */
export function isCaptcha(el: Element): boolean {
  const attrs = ['name', 'id', 'aria-label', 'placeholder', 'class', 'title'];
  return attrs.some((a) => CAPTCHA.test(el.getAttribute(a) ?? ''));
}

function isVisible(el: HTMLElement): boolean {
  if (el.hidden || (el as HTMLInputElement).type === 'hidden' || (el as HTMLInputElement).disabled) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  // Box check only where the document has layout (real browsers); jsdom reports no boxes at all.
  const hasLayout = el.ownerDocument.body ? el.ownerDocument.body.getClientRects().length > 0 : false;
  if (hasLayout && el.getClientRects().length === 0) return false;
  return true;
}

function usable(el: Element | null): el is HTMLInputElement {
  return !!el && el instanceof el.ownerDocument.defaultView!.HTMLInputElement && !isCaptcha(el) && isVisible(el) && !el.readOnly;
}

function first(doc: Document, selectors: readonly string[]): HTMLInputElement | null {
  for (const s of selectors) {
    for (const el of Array.from(doc.querySelectorAll(s))) if (usable(el)) return el;
  }
  return null;
}

type Finder = { username: readonly string[]; password: readonly string[] };

/** Per-portal login form selectors. All are best guesses from public page structure. */
export const PORTAL_SELECTORS: Partial<Record<Portal, Finder>> = {
  GST: {
    username: ['input#username', 'input[name="user_name"]'], // VERIFY AGAINST LIVE PORTAL
    password: ['input#user_pass', 'input[name="user_pass"]'], // VERIFY AGAINST LIVE PORTAL
  },
  INCOME_TAX: {
    username: ['input#panAdhaarUserId', 'input[name="panAdhaarUserId"]'], // VERIFY AGAINST LIVE PORTAL
    password: ['input#loginPasswordField', 'input[name="loginPasswordField"]'], // VERIFY AGAINST LIVE PORTAL
  },
  TRACES: {
    username: ['input#userId', 'input[name="userId"]'], // VERIFY AGAINST LIVE PORTAL
    password: ['input#psw', 'input[name="psw"]'], // VERIFY AGAINST LIVE PORTAL
  },
  MCA: {
    username: ['input#userName', 'input[name="userName"]'], // VERIFY AGAINST LIVE PORTAL
    password: ['input#password', 'input[name="password"]'], // VERIFY AGAINST LIVE PORTAL
  },
  EPFO: {
    username: ['input#username', 'input[name="username"]'], // VERIFY AGAINST LIVE PORTAL
    password: ['input#password', 'input[name="password"]'], // VERIFY AGAINST LIVE PORTAL
  },
  ESIC: {
    username: ['input#txtUserName', 'input[name="txtUserName"]'], // VERIFY AGAINST LIVE PORTAL
    password: ['input#txtPassword', 'input[name="txtPassword"]'], // VERIFY AGAINST LIVE PORTAL
  },
  DGFT: {
    username: ['input#username', 'input[name="username"]'], // VERIFY AGAINST LIVE PORTAL
    password: ['input#password', 'input[name="password"]'], // VERIFY AGAINST LIVE PORTAL
  },
};

const TEXTISH = new Set(['text', 'email', 'tel', '']);

/** Generic fallback: first visible password input, and the nearest preceding visible text/email input in the same form. */
export function genericFields(doc: Document): LoginFields {
  const password = first(doc, ['input[type="password"]']);
  if (!password) return { username: null, password: null };
  const scope: ParentNode = password.form ?? doc;
  const inputs = Array.from(scope.querySelectorAll('input'));
  let username: HTMLInputElement | null = null;
  for (const el of inputs) {
    if (el === password) break;
    if (TEXTISH.has((el.getAttribute('type') ?? '').toLowerCase()) && usable(el)) username = el;
  }
  return { username, password };
}

export function findLoginFields(portal: Portal, doc: Document): LoginFields {
  const f = PORTAL_SELECTORS[portal];
  const specific: LoginFields = f ? { username: first(doc, f.username), password: first(doc, f.password) } : { username: null, password: null };
  if (specific.username && specific.password) return specific;
  const g = genericFields(doc);
  return { username: specific.username ?? g.username, password: specific.password ?? g.password };
}

/** Sets the value through the native setter so React/Angular see it, then fires input + change. */
export function setNativeValue(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    ?? Object.getOwnPropertyDescriptor(el.ownerDocument.defaultView!.HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export type FillResult = { ok: true; filled: number } | { ok: false; reason: 'NOT_PORTAL' | 'NO_FIELDS' };

/**
 * Fills username/password on the current page. Refuses unless `href` is an allow-listed https host for `portal`.
 * Never submits, never touches CAPTCHA inputs, never reads page data back.
 */
export function fillLogin(portal: Portal, href: string, doc: Document, cred: { username: string; password: string }): FillResult {
  if (!isPortalUrl(portal, href)) return { ok: false, reason: 'NOT_PORTAL' };
  const { username, password } = findLoginFields(portal, doc);
  if (!username && !password) return { ok: false, reason: 'NO_FIELDS' };
  let filled = 0;
  if (username) { setNativeValue(username, cred.username); filled++; }
  if (password) { setNativeValue(password, cred.password); filled++; }
  return { ok: true, filled };
}
