# Integrations (adapter + mock first)

Every provider is selected by env var (see `.env.example`); `mock` is default so the whole system runs without credentials.

| Area | Interface | Needs from you | Notes |
|---|---|---|---|
| GSTIN lookup | `GstinLookupProvider` (`apps/api/src/lookup/gstin.provider.ts`; mock in use) | Licensed GSP/ASP contract + API key | Never scrape the GST portal or bypass CAPTCHA. Local checksum validation first. |
| GST/ITR/TRACES/MCA status | `GstReturnStatusProvider`, `ItrStatusProvider`, `TracesProvider`, `McaProvider` | Licensed provider | Show "last synced at" and credit usage. // VERIFY AGAINST OFFICIAL DOCS |
| WhatsApp | `MessagingProvider` (Meta Cloud API, Gupshup, Wati, Interakt) | WABA, phone number ID, token, approved templates | Rates in a configurable rate table — never hard-coded. |
| SMS | `SmsProvider` | DLT entity ID + templates | |
| Email | SMTP/SES + Gmail/Outlook OAuth | OAuth client IDs | Mailpit locally. |
| Payments | `PaymentProvider` (Razorpay; slots for Cashfree/PayU) | Key ID/secret, webhook secret | |
| Push | FCM, Web Push (VAPID) | Firebase service account; VAPID keys | |
| e-Sign | `ESignProvider` (Aadhaar eSign ASP), desktop DSC signing | ASP contract | |
| e-Invoice | `EInvoiceProvider` | IRP/GSP access | Disabled by default. |
| Tally | Desktop local connector, XML over HTTP on localhost:9000 | Tally running with ODBC/HTTP enabled | // VERIFY AGAINST TALLY DOCS |
| UDIN | Record + deep link only | — | Never imitate ICAI generation screens. |
| AI | `AiService` (Anthropic) | `ANTHROPIC_API_KEY`, per-firm opt-in | PII redaction on by default. |
| Code signing | — | Windows EV cert, Apple Developer ID | Needed for Phase 12 installers. |
| Object storage | `StorageAdapter` (`LocalStorage` dev, `S3Storage` for AWS S3 / MinIO) | `STORAGE=s3`, `S3_*` env, bucket in ap-south-1 | Per-tenant key prefix `t/{tenantId}/`; SSE-S3 requested on AWS. |
| Malware scanning | `VirusScanner` (mock flags EICAR) | ClamAV daemon or cloud AV | Uploads are refused when infected. |
| KMS | `KmsProvider` (`LocalKms`) | AWS KMS key in ap-south-1 + IAM role | Wraps per-tenant data keys. |
| Browser extension | `apps/extension` (MV3) | Chrome Web Store / Edge Add-ons developer accounts for publishing | Pairs via one-time code; autofills only allow-listed portal hosts. |
