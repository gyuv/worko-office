import { AsyncLocalStorage } from 'node:async_hooks';
import type { Causation } from '@worko/domain';

/**
 * The automation runner executes each action inside `withCausation`; `DbService.tenantTx` copies it into the
 * transaction-local `app.causation` setting, so the outbox triggers stamp every event the action causes (D144).
 */
const store = new AsyncLocalStorage<Causation>();
export const withCausation = <T>(c: Causation, fn: () => Promise<T>) => store.run(c, fn);
export const currentCausation = (): Causation | undefined => store.getStore();
