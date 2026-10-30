# Troubleshooting

| Problem | What to do |
|---|---|
| "Invalid credentials" at sign-in | Check the **Firm ID** (not the firm name). Too many attempts lock sign-in for a few minutes. |
| Lost the authenticator phone | There is no self-service reset yet: contact your Worko administrator (hosting support), who verifies you and clears it. |
| A client is missing from my list | You are not its partner/manager/staff, or it is marked sensitive. Ask a partner to add you. A task you can't open answers "not found" for the same reason. |
| Auto-creation made no task for a client | The client isn't subscribed to that service, the service has no rule for that period, or the task already exists / was deleted for that period (deleted tasks are not recreated). Use **preview** to see the reason. |
| Can't mark a task done | Required checks are open, it needs a reviewer, or it is an audit task without a UDIN. |
| Invoice can't be edited | Issued invoices are final. Use a credit/debit note, or cancel and re-issue. |
| Auto-billing skipped tasks | They have no rate (Settings → Rates), are covered by a retainer, or still need a UDIN. |
| Online payment not showing | It appears when the gateway confirms (usually seconds). If the client paid on an old, replaced link, it is recorded for review. |
| Client didn't get the portal code | Codes go to the invited contact's e-mail/mobile only; check spam; after several codes in an hour the client must wait. SMS needs the DLT template to be registered. |
| Messages to a client are "held" | Quiet hours (night) or the client opted out (STOP). Check the client's consent on the timeline. |
| Desktop shows "offline" | Work continues; changes sync when the connection returns. If a change is rejected (e.g. someone issued the invoice meanwhile) you are told and the server's version wins for money/legal records. |
| Android link opens the browser, not the app | The firm's web address must publish the app-link file (administrator: docs/RELEASE.md, Android step 5). |
| Report totals differ between two people | Reports always use the viewer's permissions. |
| "Audit chain broken" on verify | Contact your Worko administrator immediately — it means stored history was altered outside the app. |
