import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ACTIONS, MODULES, SCOPES } from '@worko/domain';
import { z } from 'zod';
import { CurrentActor, ExtensionAllowed, Perm, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { UsersService } from './users.service.js';

export const passwordSchema = z.string().min(10, 'At least 10 characters').max(200);
const createSchema = z.object({
  name: z.string().trim().min(1).max(120), email: z.string().email(), phone: z.string().regex(/^\+?\d{10,15}$/).optional(),
  password: passwordSchema, roleKeys: z.array(z.string()).min(1), branchId: z.string().uuid().optional(),
});

const grantSchema = z.object({ module: z.enum(MODULES), action: z.enum(ACTIONS), scope: z.enum(SCOPES), clientGroupIds: z.array(z.string().uuid()).max(50).optional() }).strict();
const roleCreateSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/), name: z.string().trim().min(1).max(60), grants: z.array(grantSchema).max(500), hiddenFields: z.array(z.string().max(60)).max(50).optional() }).strict();
const roleUpdateSchema = z.object({ name: z.string().trim().min(1).max(60).optional(), grants: z.array(grantSchema).max(500).optional(), hiddenFields: z.array(z.string().max(60)).max(50).optional() }).strict();
const uiPrefsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).optional(), accent: z.enum(['green', 'blue', 'teal', 'indigo', 'violet', 'rose', 'amber', 'slate']).optional(),
  fontScale: z.enum(['sm', 'md', 'lg', 'xl']).optional(), density: z.enum(['comfortable', 'compact']).optional(), motion: z.enum(['full', 'reduced']).optional(),
  glass: z.boolean().optional(), hiddenModules: z.array(z.string().max(30)).max(40).optional(), sidebar: z.enum(['expanded', 'compact']).optional(),
}).strict();
const updateSchema = z.object({
  status: z.enum(['active', 'disabled']).optional(), managerId: z.string().uuid().nullable().optional(), branchId: z.string().uuid().optional(),
  roleKeys: z.array(z.string()).min(1).optional(), name: z.string().trim().min(1).max(120).optional(), phone: z.string().regex(/^\+?\d{10,15}$/).nullable().optional(),
});

@Controller()
export class UsersController {
  constructor(private users: UsersService) {}

  @Get('me') @ExtensionAllowed()
  me(@CurrentActor() a: RequestActor) { return this.users.me(a); }

  @Get('users') @Perm('users', 'view')
  list(@CurrentActor() a: RequestActor) { return this.users.list(a); }

  @Post('users') @Perm('users', 'create')
  create(@CurrentActor() a: RequestActor, @Body(new ZodPipe(createSchema)) b: z.infer<typeof createSchema>) { return this.users.create(a, b); }

  @Patch('users/:id') @HttpCode(204) @Perm('users', 'edit')
  async update(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateSchema)) b: z.infer<typeof updateSchema>) {
    await this.users.update(a, id, b);
  }

  @Get('me/ui-prefs')
  uiPrefs(@CurrentActor() a: RequestActor) { return this.users.uiPrefs(a); }

  @Put('me/ui-prefs')
  setUiPrefs(@CurrentActor() a: RequestActor, @Body(new ZodPipe(uiPrefsSchema)) b: z.infer<typeof uiPrefsSchema>) { return this.users.setUiPrefs(a, b); }

  @Post('roles') @Perm('users', 'edit')
  createRole(@CurrentActor() a: RequestActor, @Body(new ZodPipe(roleCreateSchema)) b: z.infer<typeof roleCreateSchema>) { return this.users.createRole(a, b); }

  @Patch('roles/:id') @HttpCode(204) @Perm('users', 'edit')
  async updateRole(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(roleUpdateSchema)) b: z.infer<typeof roleUpdateSchema>) { await this.users.updateRole(a, id, b); }

  @Delete('roles/:id') @HttpCode(204) @Perm('users', 'edit')
  async deleteRole(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) { await this.users.deleteRole(a, id); }

  @Get('roles') @Perm('users', 'view')
  roles(@CurrentActor() a: RequestActor) { return this.users.roles(a); }
}
