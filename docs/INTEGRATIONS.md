# Integrations (adapter + mock first)

Every provider is selected by env var (see `.env.example`); `mock` is default so the whole system runs without credentials.

| Area | Interface | Needs from you | Notes |
|---|---|---|---|
| GSTIN lookup | `GstinLookupProvider` (`apps/api/src/lookup/gstin.provider.ts`; mock in use) | Licensed GSP/ASP contract + API key | Never scrape the GST portal or bypass CAPTCHA. Local checksum validation first. |
| GST/ITR/TRACES/MCA status | `GstReturnStatusProvider`, `ItrStatusProvider`, `TracesProvider`, `McaProvider` | Licensed provider | Show "last synced at" and credit usage. // VERIFY AGAINST OFFICIAL DOCS |
| WhatsApp | `ChannelAdapter` (`apps/api/src/comm/channels.ts`: mock default, `MetaWhatsAppAdapter` skeleton; slots for Gupshup/Wati/Interakt) + `InboundProvider` (`MetaInboundProvider`) | WABA, phone number ID, token, app secret, verify token, approved templates (`COMM_WHATSAPP_PROVIDER=meta`, `WHATSAPP_*`) | Webhook `POST /v1/comm/webhooks/{mock|meta}/{tenantId}` (signature over raw body, idempotent per event id; GET = hub.challenge). Rates in `comm_rate_card`/`comm_rate` — never hard-coded. // VERIFY AGAINST OFFICIAL DOCS |
| SMS | `ChannelAdapter` (`HttpSmsAdapter` skeleton; OTP login still uses `SmsProvider`) | DLT entity ID + registered template ids, aggregator URL/key (`COMM_SMS_PROVIDER=http`, `SMS_*`, `DLT_ENTITY_ID`) | Template `dltTemplateId` required by the adapter. // VERIFY AGAINST OFFICIAL DOCS |
| Email | `SmtpEmailAdapter` (`COMM_EMAIL_PROVIDER=smtp`, Mailpit on :1025) + Gmail/Outlook `OAuthProvider` (mail fetch, calendar two-way; mock default, Google/Microsoft skeletons) | OAuth client IDs/secrets (`GOOGLE_*`, `MS_*`), SES or relay credentials for production | Redirect `GET /v1/comm/oauth/callback`; tokens encrypted with KeyService, never logged/synced/audited. Billing follow-ups use `ClientMessenger`: `MockMessenger` with all-mock channels, else `ChannelMessenger` over the shared adapters (D98) — links only, never attachments. |
| Payments | `PaymentProvider` (`apps/api/src/billing/providers.ts`: `MockPaymentProvider` default, `RazorpayProvider` skeleton; slots for Cashfree/PayU) | Key ID/secret, webhook secret (`PAYMENT_PROVIDER`, `RAZORPAY_KEY_ID/SECRET`, `RAZORPAY_WEBHOOK_SECRET`) | Webhook `POST /v1/billing/webhooks/{provider}/{tenantId}`: HMAC-SHA256 of the raw body, idempotent per event id. // VERIFY AGAINST OFFICIAL DOCS |
| Calendar | Google Calendar / Microsoft Graph via the same `OAuthProvider` (purpose `calendar`); ICS feeds `GET /v1/calendar/ics/{tenantId}/{token}` | OAuth clients as above | External wins on conflicts (D103). // VERIFY AGAINST OFFICIAL DOCS |
| Push | FCM, Web Push (VAPID) | Firebase service account; VAPID keys | |
| e-Sign | `ESignProvider` (Aadhaar eSign ASP), desktop DSC signing | ASP contract | |
| e-Invoice | `EInvoiceProvider` | IRP/GSP access | Disabled by default. |
| Tally | XML built by `@worko/domain` `buildTallyXml` (sales/credit/debit/receipt vouchers) from `POST /billing/tally/dry-run|export` with a ledger map; desktop connector will post it to Tally on localhost:9000 | Tally running with ODBC/HTTP enabled; ledger names | Export log makes re-exports idempotent. // VERIFY AGAINST TALLY DOCS |
| UDIN | Record + deep link only | — | Never imitate ICAI generation screens. |
| AI | `AiService` (Anthropic) | `ANTHROPIC_API_KEY`, per-firm opt-in | PII redaction on by default. |
| Code signing | — | Windows EV cert, Apple Developer ID | Needed for Phase 12 installers. |
| Object storage | `StorageAdapter` (`LocalStorage` dev, `S3Storage` for AWS S3 / MinIO) | `STORAGE=s3`, `S3_*` env, bucket in ap-south-1 | Per-tenant key prefix `t/{tenantId}/`; SSE-S3 requested on AWS. |
| Malware scanning | `VirusScanner` (mock flags EICAR) | ClamAV daemon or cloud AV | Uploads are refused when infected. |
| KMS | `KmsProvider` (`LocalKms`) | AWS KMS key in ap-south-1 + IAM role | Wraps per-tenant data keys. |
| Browser extension | `apps/extension` (MV3) | Chrome Web Store / Edge Add-ons developer accounts for publishing | Pairs via one-time code; autofills only allow-listed portal hosts. |
