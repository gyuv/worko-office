import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentActor, ExtensionAllowed, Perm, type RequestActor } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { UsersService } from './users.service.js';

export const passwordSchema = z.string().min(10, 'At least 10 characters').max(200);
const createSchema = z.object({
  name: z.string().trim().min(1).max(120), email: z.string().email(), phone: z.string().regex(/^\+?\d{10,15}$/).optional(),
  password: passwordSchema, roleKeys: z.array(z.string()).min(1), branchId: z.string().uuid().optional(),
});

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

  @Get('roles') @Perm('users', 'view')
  roles(@CurrentActor() a: RequestActor) { return this.users.roles(a); }
}
