import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export type RealtimeEvent =
  | { type: 'changed'; tenantId: string; cursor: number; userIds?: string[] }
  | { type: 'session_revoked'; tenantId: string; sessionId: string; wipe: boolean };

/**
 * In-process fan-out. Single-node today; for multiple API nodes, swap the emitter for Redis pub/sub
 * behind this same interface (see KNOWN_GAPS).
 */
@Injectable()
export class RealtimeService {
  private bus = new EventEmitter().setMaxListeners(0);
  publish(e: RealtimeEvent) { this.bus.emit('event', e); }
  subscribe(fn: (e: RealtimeEvent) => void): () => void {
    this.bus.on('event', fn);
    return () => this.bus.off('event', fn);
  }
}
