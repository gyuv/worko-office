/** Thrown for a mutation that must be rejected (DB constraint or a hook's business rule): rejected, never retried. */
export class RejectError extends Error {}
