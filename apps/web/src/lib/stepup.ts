import { create } from 'zustand';
import { errCode } from './http';

/** Global step-up (re-authentication) prompt. Screens await `requestStepUp()`; StepUpDialog resolves it. */
type StepUpState = { open: boolean; resolve: ((ok: boolean) => void) | null };
export const useStepUp = create<StepUpState>(() => ({ open: false, resolve: null }));

export function requestStepUp(): Promise<boolean> {
  return new Promise((resolve) => {
    useStepUp.getState().resolve?.(false);
    useStepUp.setState({ open: true, resolve });
  });
}
export function finishStepUp(ok: boolean) {
  const r = useStepUp.getState().resolve;
  useStepUp.setState({ open: false, resolve: null });
  r?.(ok);
}

export class StepUpCancelled extends Error { constructor() { super('step-up cancelled'); } }

/** Runs a sensitive call; on 403 STEP_UP_REQUIRED asks the user to re-authenticate and retries once. */
export async function withStepUp<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (errCode(e) !== 'STEP_UP_REQUIRED') throw e;
    if (!(await requestStepUp())) throw new StepUpCancelled();
    return fn();
  }
}
