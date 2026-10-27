import { Body, Controller, ForbiddenException, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Public } from '../auth/context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { passwordSchema } from '../users/users.controller.js';
import { TenancyService } from './tenancy.service.js';

const signupSchema = z.object({
  firmName: z.string().trim().min(2).max(200),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Lowercase letters, digits and hyphens'),
  stateCode: z.string().regex(/^\d{2}$/),
  partner: z.object({ name: z.string().trim().min(1).max(120), email: z.string().email(), password: passwordSchema, phone: z.string().regex(/^\+?\d{10,15}$/).optional() }),
});

@Controller('tenants')
export class TenancyController {
  constructor(private tenancy: TenancyService) {}

  /** Self-serve firm signup; disable with ALLOW_SIGNUP=false (super-admin provisioning only). */
  @Public() @Throttle({ default: { limit: Number(process.env.SIGNUP_RATE_LIMIT ?? 5), ttl: 3_600_000 } }) @Post('signup')
  signup(@Body(new ZodPipe(signupSchema)) b: z.infer<typeof signupSchema>) {
    if (process.env.ALLOW_SIGNUP === 'false') throw new ForbiddenException('Signup is disabled');
    return this.tenancy.signup(b);
  }
}
