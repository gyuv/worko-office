import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ACTIONS, apiKeyCreateSchema, MODULES, webhookCreateSchema, webhookPatchSchema, WEBHOOK_EVENTS, type ApiKeyCreate } from '@worko/domain';
import { z } from 'zod';
import { ClientIp, CurrentActor, Perm, Public, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ApiKeysService } from './api-keys.service.js';
import { PUBLIC_OPENAPI } from './openapi.public.js';
import { WebhooksService } from './webhooks.service.js';

const pageQ = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });

/** Settings → Developers (M18): API keys and webhook subscriptions. Firm configuration: settings:view / settings:edit. */
@Controller('developers')
export class DevelopersController {
  constructor(private keys: ApiKeysService, private hooks: WebhooksService) {}

  /** Scopes the caller could grant (module:action pairs they hold) and the webhook event catalogue. */
  @Get('catalogue') @Perm('settings', 'view')
  catalogue(@CurrentActor() a: RequestActor) {
    const held = new Set(a.roles.flatMap((r) => r.grants.filter((g) => g.scope !== 'none').map((g) => `${g.module}:${g.action}`)));
    return { scopes: MODULES.flatMap((m) => ACTIONS.map((x) => `${m}:${x}`)).filter((s) => held.has(s)), events: WEBHOOK_EVENTS, docsUrl: '/v1/public-api/openapi.json' };
  }

  @Get('api-keys') @Perm('settings', 'view')
  listKeys(@CurrentActor() a: RequestActor) { return this.keys.list(a); }

  @Post('api-keys') @Perm('settings', 'edit')
  createKey(@CurrentActor() a: RequestActor, @Body(new ZodPipe(apiKeyCreateSchema)) b: ApiKeyCreate, @ClientIp() ip: string | null) { return this.keys.create(a, b, ip); }

  @Post('api-keys/:id/rotate') @HttpCode(200) @Perm('settings', 'edit')
  rotateKey(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) { return this.keys.rotate(a, id, ip); }

  @Delete('api-keys/:id') @HttpCode(204) @Perm('settings', 'edit')
  async revokeKey(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) { await this.keys.revoke(a, id, ip); }

  @Get('webhooks') @Perm('settings', 'view')
  listHooks(@CurrentActor() a: RequestActor) { return this.hooks.list(a); }

  @Post('webhooks') @Perm('settings', 'edit')
  createHook(@CurrentActor() a: RequestActor, @Body(new ZodPipe(webhookCreateSchema)) b: z.infer<typeof webhookCreateSchema>, @ClientIp() ip: string | null) { return this.hooks.create(a, b, ip); }

  @Patch('webhooks/:id') @Perm('settings', 'edit')
  updateHook(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(webhookPatchSchema)) b: z.infer<typeof webhookPatchSchema>, @ClientIp() ip: string | null) {
    return this.hooks.update(a, id, b, ip);
  }

  @Delete('webhooks/:id') @HttpCode(204) @Perm('settings', 'edit')
  async deleteHook(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) { await this.hooks.remove(a, id, ip); }

  @Post('webhooks/:id/rotate-secret') @HttpCode(200) @Perm('settings', 'edit')
  rotateHook(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) { return this.hooks.rotateSecret(a, id, ip); }

  @Post('webhooks/:id/ping') @HttpCode(202) @Perm('settings', 'edit')
  ping(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.hooks.ping(a, id); }

  @Get('webhooks/:id/deliveries') @Perm('settings', 'view')
  deliveries(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(pageQ)) q: z.infer<typeof pageQ>) { return this.hooks.deliveries(a, id, q); }

  @Post('webhook-deliveries/:id/redeliver') @HttpCode(202) @Perm('settings', 'edit')
  redeliver(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null) { return this.hooks.redeliver(a, id, ip); }
}

/** The public API's own OpenAPI document (operations tagged `public` in docs/openapi.yaml), generated at build time. */
@Public()
@Controller('public-api')
export class PublicApiDocsController {
  @Get('openapi.json')
  spec() { return PUBLIC_OPENAPI; }
}
