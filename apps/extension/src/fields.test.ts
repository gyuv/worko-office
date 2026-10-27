// @vitest-environment jsdom
import { type Portal } from '@worko/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { fillLogin, findLoginFields, genericFields, isCaptcha } from './fields.js';

const FORMS: Record<string, { portal: Portal; url: string; html: string; user: string; pass: string }> = {
  GST: { portal: 'GST', url: 'https://services.gst.gov.in/services/login', user: 'username', pass: 'user_pass',
    html: '<form><input id="username" type="text"><input id="user_pass" type="password"><input id="captcha" type="text"></form>' },
  INCOME_TAX: { portal: 'INCOME_TAX', url: 'https://eportal.incometax.gov.in/iec/foservices/#/login', user: 'panAdhaarUserId', pass: 'loginPasswordField',
    html: '<form><input id="panAdhaarUserId"><input id="loginPasswordField" type="password"></form>' },
  TRACES: { portal: 'TRACES', url: 'https://www.tdscpc.gov.in/app/login.xhtml', user: 'userId', pass: 'psw',
    html: '<form><input id="userId"><input id="tanpan"><input id="psw" type="password"><input id="captchaInput" type="text"></form>' },
  MCA: { portal: 'MCA', url: 'https://www.mca.gov.in/content/mca/global/en/foportal/fologin.html', user: 'userName', pass: 'password',
    html: '<form><input id="userName"><input id="password" type="password"></form>' },
  EPFO: { portal: 'EPFO', url: 'https://unifiedportal-emp.epfindia.gov.in/epfo/', user: 'username', pass: 'password',
    html: '<form><input id="username"><input id="password" type="password"><input name="captcha" aria-label="Captcha"></form>' },
  ESIC: { portal: 'ESIC', url: 'https://portal.esic.gov.in/EmployerPortal/ESICInsurancePortal/Portal_Loginnew.aspx', user: 'txtUserName', pass: 'txtPassword',
    html: '<form><input id="txtUserName"><input id="txtPassword" type="password"><input id="txtCaptcha"></form>' },
};

beforeEach(() => { document.body.innerHTML = ''; });

describe('per-portal field finders', () => {
  for (const [name, f] of Object.entries(FORMS)) {
    it(`finds ${name} login fields`, () => {
      document.body.innerHTML = f.html;
      const r = findLoginFields(f.portal, document);
      expect(r.username?.id).toBe(f.user);
      expect(r.password?.id).toBe(f.pass);
    });
  }
});

describe('generic fallback', () => {
  it('uses first visible password + nearest preceding text/email input in the same form', () => {
    document.body.innerHTML = `
      <form id="search"><input id="q" type="text"></form>
      <form id="login"><input id="hidden" type="hidden"><input id="email" type="email"><input id="u2" type="text" style="display:none">
        <input id="pw" type="password"><input id="after" type="text"></form>`;
    const r = genericFields(document);
    expect(r.password?.id).toBe('pw');
    expect(r.username?.id).toBe('email');
  });

  it('kicks in for a portal whose markup changed', () => {
    document.body.innerHTML = '<form><input id="login-id" type="text"><input id="secret" type="password"></form>';
    const r = findLoginFields('GST', document);
    expect([r.username?.id, r.password?.id]).toEqual(['login-id', 'secret']);
  });

  it('never selects captcha inputs', () => {
    document.body.innerHTML = '<form><input id="user"><input placeholder="Enter CAPTCHA" id="c1"><input type="password" id="pw"></form>';
    expect(genericFields(document).username?.id).toBe('user');
    document.body.innerHTML = '<form><input id="captchaText"><input type="password" id="pw"></form>';
    expect(genericFields(document).username).toBeNull();
    document.body.innerHTML = '<form><input id="username" name="captcha_user"><input type="password" id="pw"></form>';
    expect(findLoginFields('EPFO', document).username).toBeNull();
  });

  it('isCaptcha checks name/id/aria-label/placeholder', () => {
    for (const a of ['name', 'id', 'aria-label', 'placeholder']) {
      const el = document.createElement('input'); el.setAttribute(a, 'Captcha code');
      expect(isCaptcha(el)).toBe(true);
    }
    expect(isCaptcha(document.createElement('input'))).toBe(false);
  });
});

describe('fillLogin', () => {
  it('sets values via the native setter and dispatches input + change; never touches captcha', () => {
    const f = FORMS.GST!;
    document.body.innerHTML = f.html;
    const events: string[] = [];
    for (const el of Array.from(document.querySelectorAll('input'))) {
      el.addEventListener('input', () => events.push(`input:${el.id}`));
      el.addEventListener('change', () => events.push(`change:${el.id}`));
    }
    // Simulate a framework that shadows the instance `value` property (as React does).
    const u = document.getElementById('username') as HTMLInputElement;
    Object.defineProperty(u, 'value', { configurable: true, get: () => 'shadow', set: () => { throw new Error('instance setter used'); } });
    const r = fillLogin('GST', f.url, document, { username: 'ACME01', password: 'p@ss' });
    expect(r).toEqual({ ok: true, filled: 2 });
    delete (u as unknown as Record<string, unknown>).value;
    expect(u.value).toBe('ACME01');
    expect((document.getElementById('user_pass') as HTMLInputElement).value).toBe('p@ss');
    expect((document.getElementById('captcha') as HTMLInputElement).value).toBe('');
    expect(events).toEqual(['input:username', 'change:username', 'input:user_pass', 'change:user_pass']);
  });

  it('refuses when the location host is not allow-listed for the portal', () => {
    const f = FORMS.GST!;
    for (const url of ['https://services.gst.gov.in.evil.com/login', 'http://services.gst.gov.in/login', 'https://eportal.incometax.gov.in/', 'https://services.gst.gov.in:8443/']) {
      document.body.innerHTML = f.html;
      expect(fillLogin('GST', url, document, { username: 'x', password: 'y' })).toEqual({ ok: false, reason: 'NOT_PORTAL' });
      expect((document.getElementById('user_pass') as HTMLInputElement).value).toBe('');
    }
    document.body.innerHTML = '<form><input type="password"></form>';
    expect(fillLogin('BANK', 'https://netbanking.example.com/', document, { username: 'x', password: 'y' }).ok).toBe(false);
  });

  it('reports NO_FIELDS on a page without a login form', () => {
    document.body.innerHTML = '<p>hello</p>';
    expect(fillLogin('MCA', FORMS.MCA!.url, document, { username: 'x', password: 'y' })).toEqual({ ok: false, reason: 'NO_FIELDS' });
  });
});
