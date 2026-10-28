import { isPortalUrl, PORTALS, type Portal } from '@worko/domain';
import { fillLogin } from './fields.js';
import type { FillMessage } from './messages.js';

function isFillMessage(m: unknown): m is FillMessage {
  const o = m as Partial<FillMessage> | null;
  return !!o && o.type === 'worko:fill' && typeof o.username === 'string' && typeof o.password === 'string'
    && typeof o.portal === 'string' && (PORTALS as readonly string[]).includes(o.portal);
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  // Only our own background may talk to us, and only in the top frame.
  if (sender.id !== chrome.runtime.id || sender.tab || window.top !== window) return;
  if (!isFillMessage(msg)) return;
  const portal: Portal = msg.portal;
  let cred: { username: string; password: string } | null = { username: msg.username, password: msg.password };
  msg.username = ''; msg.password = '';
  const result = isPortalUrl(portal, location.href)
    ? fillLogin(portal, location.href, document, cred)
    : { ok: false as const, reason: 'NOT_PORTAL' as const };
  cred = null;
  sendResponse(result);
});
