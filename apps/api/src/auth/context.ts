import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Action, Actor, Module } from '@worko/domain';

export type RequestActor = Actor & { tenantId: string; sessionId: string; deviceId: string; platform?: string; elevatedUntil?: Date | null };

export const IS_PUBLIC = 'worko:public';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const PERM = 'worko:perm';
/** Route requires at least some scope for module × action; row-level scope is checked in the service. */
export const Perm = (module: Module, action: Action) => SetMetadata(PERM, { module, action });

/** Routes an `extension` session may call (vault autofill). Everything else is refused for that platform. */
export const EXTENSION_OK = 'worko:extension';
export const ExtensionAllowed = () => SetMetadata(EXTENSION_OK, true);

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestActor => ctx.switchToHttp().getRequest().actor);
export const ClientIp = createParamDecorator((_: unknown, ctx: ExecutionContext): string | null => ctx.switchToHttp().getRequest().ip ?? null);
