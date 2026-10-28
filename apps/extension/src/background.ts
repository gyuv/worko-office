import { handle, isTrustedSender } from './bg.js';
import type { PopupRequest } from './messages.js';

chrome.runtime.onMessage.addListener((msg: PopupRequest, sender, sendResponse) => {
  if (!isTrustedSender(sender)) return false;
  handle(msg).then(sendResponse, () => sendResponse({ ok: false, error: 'INTERNAL' }));
  return true;
});
