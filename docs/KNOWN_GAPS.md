# Known gaps

| Area | Gap | Plan |
|---|---|---|
| Rule pack | Seed due dates are UNVERIFIED sample data; ITR dates by form/category changed in 2026 and are not modelled precisely. | Verify each rule against notifications, set `verified`/`source`. |
| Rule engine | `event` frequency (AGM-relative AOC-4/MGT-7, DIR-3 KYC per DIN) not generated yet. | Phase 4: event triggers create due items. |
| Rule engine | JSON-Schema export for external editors not yet emitted (zod only). | zod-to-json-schema in Phase 4. |
| UDIN | Regex assumes 2-digit year + 6-digit membership + 10 alphanumerics. | VERIFY AGAINST OFFICIAL ICAI DOCS. |
| Migrations | `0001_foundation.sql` is applied manually / by docker init; no migration runner yet. | Drizzle migrator in Phase 1. |
| Apps | Web, desktop and Android shells not yet created. | Phase 1 remaining tasks. |
| Sync | Simulator models a single entity type and permission filter; no clock-skew dimension needed (server-order LWW) but chaos/load tests pending. | Phase 2. |
| Providers | No external adapters implemented yet (all listed in INTEGRATIONS.md). | Per phase. |
