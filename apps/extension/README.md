# Worko Autofill (browser extension)

Chrome/Edge Manifest V3 extension that fills government-portal logins from the firm's Worko credential vault.

## Build

```sh
pnpm --filter @worko/extension build      # → apps/extension/dist
pnpm --filter @worko/extension test       # vitest (manifest, field finders, background flow)
```

`build.mjs` bundles `src/background.ts` (ESM service worker), `src/popup.ts` and `src/content.ts` (IIFE) with esbuild,
copies `public/popup.{html,css}`, and writes `dist/manifest.json` from `src/manifest.ts`, computing content-script
`matches` from `PORTAL_HOSTS` in `@worko/domain`.

## Load unpacked

1. Chrome: `chrome://extensions` (Edge: `edge://extensions`) → enable **Developer mode**.
2. **Load unpacked** → choose `apps/extension/dist`. Re-run the build and press reload after changes.

## Pair

1. In the Worko web app, open the vault's browser-extension screen and generate a one-time code (`POST /vault/extension/pair-code`).
2. Click the extension icon, enter the firm ID, the code and (if not `http://localhost:3000/v1`) your API address.
   A custom API origin triggers a Chrome permission prompt.
3. Open an official portal login page, pick the client, press **Fill**. The first fill asks for your password or a
   6-digit authenticator code (step-up, valid 5 minutes). Enter the CAPTCHA and sign in yourself.

## Security model (brief)

- **Allow-list only.** The content script is injected only on `https://<host>/*` for hosts in `PORTAL_HOSTS`. BANK, PT
  and OTHER are never autofilled. Permissions: `storage` only, plus host access for those portal hosts and the API origin.
- **Tokens** live in `chrome.storage.session` (memory, gone when the browser closes, not readable by content scripts).
  Only the API base URL and firm ID go to `chrome.storage.local`. Sign-out or a server `DEVICE_WIPE` clears the session.
- **Credentials** are revealed in the background service worker only when you press Fill, with
  `{purpose: 'autofill', pageUrl}` (the server re-checks the host and requires a recent step-up and records an audit entry). Before
  sending, the background re-reads the tab URL and checks `isPortalUrl(secret.portal, url)`. Credentials go only to
  that tab's top frame (`frameId: 0`), and the content script checks `location.href` again before filling.
- The content script never submits forms, never touches CAPTCHA inputs, and never sends page data back. The
  background accepts messages only from the extension's own popup.

## Known approximations

- Per-portal selectors in `src/fields.ts` are best guesses (`// VERIFY AGAINST LIVE PORTAL`). A generic fallback
  (first visible password input plus the nearest preceding text/email input) covers markup changes.
- UI strings are English-only in `src/strings.ts` (not `@worko/i18n`).
