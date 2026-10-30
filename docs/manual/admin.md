# Administration

## Security
- **Security**: two-factor (TOTP), your devices and sessions. Partners/admins can sign a device out or **wipe** it
  remotely (desktop/Android erase the local data and tokens on next contact).
- Roles: the built-in roles (see Getting started) define module × action × scope (own / team / all) and hidden fields;
  custom roles are not available yet. Sensitive clients are visible only to the people named on them. Changing who can
  see a client removes its data from devices that lose access.
- Credential vault: envelope-encrypted per firm; reveal needs permission and is audited; never in logs, messages or
  exports. The browser extension autofills only on allow-listed government portals.
- **Audit log**: every change, with who/when/device; hash-chained so tampering is detectable (**Audit log → Verify**);
  export for your auditors.

## Privacy (DPDP Act)
**Settings → Privacy** holds the firm's data-protection tools: the inventory of personal data Worko keeps, consent
records (e.g. WhatsApp opt-in/opt-out), data-principal requests (access/export and erasure, with approval) and the
breach register. Erasure is applied to live data; copies inside backups expire with the backup retention (docs/DR.md).
Statutory records you must keep (invoices, audit trail) are retained as the law requires.

## Integrations
- **Settings → Communication**: e-mail/WhatsApp/SMS providers, templates, quiet hours, caps.
- **Settings → Client portal**: branding, default grants, invitations.
- **Settings → Tally**: ledger mapping. **Settings → Developers**: API keys and webhooks for your own systems.
- Payment gateway and e-sign provider are configured by whoever hosts Worko (environment settings).

## Desktop app
Installs per user (Windows installer, macOS dmg, Linux AppImage). It starts with your computer (can be turned off from
the tray), stays in the tray when the window is closed so reminders still pop up, keeps your data available offline and
syncs when back online. Links starting with `worko://` (e.g. `worko://tasks/<id>`) open the app on that screen.

## Android app — permissions and why
| Permission | Used for | When asked |
|---|---|---|
| Notifications | Task, approval and reminder alerts | First launch (Android 13+) |
| Location (approximate/precise, while in use) | Attendance check-in/out at the office or an approved client site — the single point at check-in/out only, no tracking | When you tap Check in |
| Camera | Scanning client documents and receipts | When you scan |
| Exact alarms, run at start-up | Deadline reminders that fire on time and survive a phone restart, even offline | Granted at install |
Background location, microphone, storage and "draw over other apps" are blocked. Data on the phone is in an encrypted
database; a remote wipe erases it. App backups to Google are disabled.
