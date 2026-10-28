import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { PORTALS } from '@worko/domain';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentActor, ExtensionAllowed, Perm, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { VaultService } from './vault.service.js';

const secretIn = z.object({
  portal: z.enum(PORTALS), label: z.string().trim().min(1).max(100), loginUrl: z.string().url().max(500).nullable().optional(),
  username: z.string().min(1).max(200), password: z.string().min(1).max(500), extra: z.record(z.string().max(500)).nullable().optional(),
});
const listQ = z.object({ clientId: z.string().uuid().optional(), portal: z.enum(PORTALS).optional(), q: z.string().max(100).optional() });
const revealB = z.object({ purpose: z.enum(['view', 'copy', 'autofill']), pageUrl: z.string().url().max(2000).optional() });

@Controller()
export class VaultController {
  constructor(private vault: VaultService) {}

  @Get('vault/secrets') @Perm('vault', 'view') @ExtensionAllowed()
  list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listQ)) q: z.infer<typeof listQ>) { return this.vault.list(a, q); }

  @Post('clients/:id/secrets') @Perm('vault', 'create')
  create(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(secretIn)) b: z.infer<typeof secretIn>) { return this.vault.create(a, id, b); }

  @Patch('vault/secrets/:id') @HttpCode(204) @Perm('vault', 'edit')
  async update(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(secretIn.partial())) b: Partial<z.infer<typeof secretIn>>) { await this.vault.update(a, id, b); }

  @Delete('vault/secrets/:id') @HttpCode(204) @Perm('vault', 'delete')
  async remove(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.vault.remove(a, id); }

  @Post('vault/secrets/:id/reveal') @HttpCode(200) @Perm('vault', 'reveal') @ExtensionAllowed()
  reveal(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(revealB)) b: z.infer<typeof revealB>, @Req() req: Request) {
    return this.vault.reveal(a, id, b.purpose, b.pageUrl, req.ip ?? null);
  }

  @Post('vault/extension/pair-code') @Perm('vault', 'reveal')
  pairCode(@CurrentActor() a: RequestActor) { return this.vault.pairCode(a); }
}
