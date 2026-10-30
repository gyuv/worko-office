import { SetMetadata } from '@nestjs/common';

/**
 * Routes an API key may call (M18, D190). Default deny: a request authenticated with an API key reaches ONLY handlers
 * carrying this marker; staff-only, portal and platform routes refuse keys in the guard before any pipe runs.
 */
export const PUBLIC_API = 'worko:public-api';
export const PublicApi = () => SetMetadata(PUBLIC_API, true);

/** Attached to the request by the guard when an API key authenticated it. */
export type ApiKeyPrincipal = { id: string; prefix: string; tenantId: string; createdBy: string };
