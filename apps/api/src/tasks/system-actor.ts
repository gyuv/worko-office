import { effectiveScope, type Action, type Module } from '@worko/domain';
import { ForbiddenException } from '@nestjs/common';
import type { RequestActor } from '../auth/context.js';

/** Actor for server-initiated work (jobs): sees everything in its tenant, audited with a null actor. */
export function systemActor(tenantId: string): RequestActor {
  return { userId: null as unknown as string, tenantId, sessionId: '', deviceId: 'server', teamIds: [], branchId: null, roles: [], superAdmin: true };
}

/** Firm-wide decisions (approving packs/extensions, catalogue installs) need the permission at 'all' scope. */
export function requireFirmWide(a: RequestActor, module: Module, action: Action) {
  if (a.superAdmin) return;
  if (effectiveScope(a, module, action)?.scope !== 'all') throw new ForbiddenException(`Needs firm-wide ${module}:${action}`);
}
