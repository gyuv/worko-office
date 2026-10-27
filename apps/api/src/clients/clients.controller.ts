import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { isValidGstin } from '@worko/domain';
import { z } from 'zod';
import { CurrentActor, Perm, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { accessIn, clientCreate, clientPatch, contactIn, registrationIn, type AccessIn, type ClientCreate, type ClientPatch } from './clients.schemas.js';
import { ClientsService } from './clients.service.js';

const listQ = z.object({
  q: z.string().max(100).optional(), status: z.enum(['active', 'inactive', 'prospect']).optional(), groupId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0),
});
const dupB = z.object({ name: z.string().max(300).optional(), pan: z.string().max(10).optional(), gstin: z.string().max(15).optional(), phone: z.string().max(16).optional(), excludeId: z.string().uuid().optional() });
const groupB = z.object({ name: z.string().trim().min(1).max(200), kind: z.enum(['family', 'group', 'other']).default('group'), parentId: z.string().uuid().nullable().optional(), notes: z.string().max(2000).nullable().optional() });
const fieldB = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), label: z.string().trim().min(1).max(100), type: z.enum(['text', 'number', 'date', 'select', 'boolean']),
  options: z.array(z.string().max(100)).max(100).optional(), required: z.boolean().optional(), sort: z.number().int().optional() });

@Controller()
export class ClientsController {
  constructor(private clients: ClientsService) {}

  @Get('clients') @Perm('clients', 'view')
  list(@CurrentActor() a: RequestActor, @Query(new ZodPipe(listQ)) q: z.infer<typeof listQ>) { return this.clients.list(a, q); }

  @Post('clients') @Perm('clients', 'create')
  create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(clientCreate)) b: ClientCreate) { return this.clients.create(a, b); }

  @Post('clients/duplicates') @HttpCode(200) @Perm('clients', 'view')
  duplicates(@CurrentActor() a: RequestActor, @Body(new ZodPipe(dupB)) b: z.infer<typeof dupB>) { return this.clients.duplicates(a, b); }

  @Get('clients/:id') @Perm('clients', 'view')
  get(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { return this.clients.get(a, id); }

  @Patch('clients/:id') @HttpCode(204) @Perm('clients', 'edit')
  async update(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(clientPatch)) b: ClientPatch) { await this.clients.update(a, id, b); }

  @Put('clients/:id/access') @HttpCode(204) @Perm('clients', 'edit')
  async access(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(accessIn)) b: AccessIn) { await this.clients.setAccess(a, id, b); }

  @Delete('clients/:id') @HttpCode(204) @Perm('clients', 'delete')
  async remove(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.clients.remove(a, id); }

  @Post('clients/:id/merge') @HttpCode(204) @Perm('clients', 'delete')
  async merge(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ intoId: z.string().uuid() }))) b: { intoId: string }) {
    await this.clients.merge(a, id, b.intoId);
  }

  @Post('clients/:id/reveal') @HttpCode(200) @Perm('clients', 'reveal')
  reveal(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ field: z.enum(['aadhaar', 'bankAccounts']) }))) b: { field: 'aadhaar' | 'bankAccounts' }) {
    return this.clients.revealPii(a, id, b.field);
  }

  @Post('clients/:id/registrations') @Perm('clients', 'edit')
  async addRegistration(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(registrationIn)) b: ClientCreate['registrations'][number]) {
    return this.clients.withEditable(a, id, (tx) => this.clients.addRegistration(tx, a, id, b), 'client_registration.created', b);
  }

  @Post('clients/:id/contacts') @Perm('clients', 'edit')
  async addContact(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(contactIn)) b: ClientCreate['contacts'][number]) {
    return this.clients.withEditable(a, id, (tx) => this.clients.addContact(tx, a, id, b), 'contact.created', b);
  }

  @Get('lookup/gstin/:gstin') @Perm('clients', 'create')
  lookup(@Param('gstin', new ZodPipe(z.string().toUpperCase().refine(isValidGstin, 'Invalid GSTIN'))) gstin: string) { return this.clients.lookupGstin(gstin); }

  @Get('client-groups') @Perm('clients', 'view')
  groups(@CurrentActor() a: RequestActor) { return this.clients.groups(a); }

  @Post('client-groups') @Perm('clients', 'edit')
  createGroup(@CurrentActor() a: RequestActor, @Body(new ZodPipe(groupB)) b: z.infer<typeof groupB>) { return this.clients.createGroup(a, b); }

  @Get('custom-fields') @Perm('clients', 'view')
  customFields(@CurrentActor() a: RequestActor) { return this.clients.customFields(a); }

  @Post('custom-fields') @Perm('settings', 'edit')
  createField(@CurrentActor() a: RequestActor, @Body(new ZodPipe(fieldB)) b: z.infer<typeof fieldB>) { return this.clients.createCustomField(a, b); }
}
