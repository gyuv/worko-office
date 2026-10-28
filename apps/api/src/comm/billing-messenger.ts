import { Injectable } from '@nestjs/common';
import { normalizeAddress } from '@worko/domain';
import type { ClientMessage, ClientMessenger } from '../billing/providers.js';
import { Clock } from '../common/clock.js';
import { DbService } from '../db/db.service.js';
import { MockChannelHub } from './channels.js';
import { CommService } from './comm.service.js';

/**
 * Billing follow-ups / "send invoice" go through the communication pipeline (D98, revised): address normalisation,
 * consent/opt-out (a STOP'd client gets no WhatsApp/SMS dunning), quiet hours, caps, cost metering and the client
 * timeline all apply; category transactional, plain text (links only).
 */
@Injectable()
export class CommMessenger implements ClientMessenger {
  /** Messages that reached a channel (tests read this, as they did MockMessenger's). */
  readonly outbox: ClientMessage[] = [];
  constructor(private db: DbService, private comm: CommService, private clock: Clock, private hub: MockChannelHub) {}
  /** Test hook: recipients whose sends fail (the mock channels' failure list). */
  get failTo() { return this.hub.failTo; }

  async send(m: ClientMessage): Promise<{ status: 'sent' | 'failed'; ref?: string; error?: string }> {
    const now = this.clock.now();
    const address = normalizeAddress(m.channel, m.to);
    if (!address) return { status: 'failed', error: 'invalid_address' };
    const q = await this.db.tenantTx(m.tenantId, async (tx) => {
      const inv = (await tx.query('SELECT client_id FROM invoice WHERE id = $1', [m.invoiceId])).rows[0];
      return this.comm.queueTx(tx, m.tenantId, { clientId: inv?.client_id ?? null, contactId: null, channel: m.channel, address, category: 'transactional',
        subject: m.channel === 'email' ? m.subject : null, text: m.text, createdBy: null, now, meta: { invoiceId: m.invoiceId }, format: 'text' });
    });
    if ('error' in q) return { status: 'failed', error: q.error };
    if (q.sendAt > now) return { status: 'sent', ref: `queued:${q.id}` };
    const r = await this.comm.deliverNow(m.tenantId, q.id, now);
    if (r === 'sent') { this.outbox.push(m); return { status: 'sent', ref: q.id }; }
    if (r === 'queued') return { status: 'sent', ref: `queued:${q.id}` };
    return { status: 'failed', error: r === 'cancelled' ? 'opted_out' : 'send_failed' };
  }
}
