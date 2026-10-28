import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/me';
import { ClientInvoices } from './AgeingReport';
import { RecordReceiptDialog } from './ReceiptsScreen';

/** Client 360 → Billing: outstanding receivables, advance and net, with a quick "record receipt". */
export function ClientBillingTab({ client }: { client: { id: string; name: string } }) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const [recording, setRecording] = useState(false);
  return (
    <div className="card space-y-2 p-3">
      <div className="flex flex-wrap gap-2">
        <a className="btn" href="#/billing/invoices">{t('bill.tab.invoices')}</a>
        {can('receipts', 'create') && <button className="btn btn-primary" onClick={() => setRecording(true)}>{t('rcpt.record')}</button>}
      </div>
      <ClientInvoices clientId={client.id} />
      {recording && <RecordReceiptDialog initialClient={client} onClose={() => setRecording(false)} onDone={() => { setRecording(false); void qc.invalidateQueries({ queryKey: ['billing'] }); void qc.invalidateQueries({ queryKey: ['receipts'] }); }} />}
    </div>
  );
}
