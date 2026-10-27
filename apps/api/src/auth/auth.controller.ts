import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { can } from '@worko/domain';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe.js';
import { AuthService, type Meta } from './auth.service.js';
import { CurrentActor, Public, type RequestActor } from './context.js';

const device = z.object({ platform: z.enum(['web', 'desktop', 'android']), label: z.string().max(100).optional(), deviceId: z.string().max(64).optional() });
const firm = z.string().trim().min(2).max(63);
const phone = z.string().regex(/^\+?\d{10,15}$/, 'Invalid phone number');
const loginSchema = z.object({ firm, email: z.string().email(), password: z.string().min(1).max(200), totp: z.string().regex(/^\d{6}$/).optional(), device });
const otpRequestSchema = z.object({ firm, phone });
const otpVerifySchema = z.object({ firm, phone, code: z.string().regex(/^\d{6}$/), device });
const refreshSchema = z.object({ refreshToken: z.string().min(20).max(300), deviceId: z.string().max(64).optional() });
const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

const meta = (req: Request): Meta => ({ ip: req.ip ?? null, userAgent: req.headers['user-agent'] });
const AUTH_LIMIT = { default: { limit: Number(process.env.AUTH_RATE_LIMIT ?? 10), ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public() @Throttle(AUTH_LIMIT) @Post('login') @HttpCode(200)
  login(@Body(new ZodPipe(loginSchema)) b: z.infer<typeof loginSchema>, @Req() req: Request) {
    return this.auth.login(b.firm, b.email, b.password, b.totp, b.device, meta(req));
  }

  @Public() @Throttle(AUTH_LIMIT) @Post('otp/request') @HttpCode(202)
  async otpRequest(@Body(new ZodPipe(otpRequestSchema)) b: z.infer<typeof otpRequestSchema>) {
    await this.auth.requestOtp(b.firm, b.phone);
    return { sent: true }; // same answer whether or not the number exists
  }

  @Public() @Throttle(AUTH_LIMIT) @Post('otp/verify') @HttpCode(200)
  otpVerify(@Body(new ZodPipe(otpVerifySchema)) b: z.infer<typeof otpVerifySchema>, @Req() req: Request) {
    return this.auth.verifyOtp(b.firm, b.phone, b.code, b.device, meta(req));
  }

  @Public() @Throttle({ default: { limit: 30, ttl: 60_000 } }) @Post('refresh') @HttpCode(200)
  refresh(@Body(new ZodPipe(refreshSchema)) b: z.infer<typeof refreshSchema>, @Req() req: Request) {
    return this.auth.refresh(b.refreshToken, b.deviceId, meta(req));
  }

  @Post('logout') @HttpCode(204)
  async logout(@CurrentActor() a: RequestActor) { await this.auth.logout(a); }

  @Get('sessions')
  sessions(@CurrentActor() a: RequestActor) { return this.auth.listSessions(a); }

  @Post('sessions/:id/revoke') @HttpCode(204)
  async revoke(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) {
    await this.assertCanManage(a, id);
    await this.auth.revokeSession(a, id);
  }

  /** Lost device: revoke + instruct the device to erase its local database on next contact. */
  @Post('sessions/:id/wipe') @HttpCode(204)
  async wipe(@CurrentActor() a: RequestActor, @Param('id', ParseUUIDPipe) id: string) {
    await this.assertCanManage(a, id);
    await this.auth.revokeSession(a, id, 'auth.remote_wipe', true);
  }

  @Post('totp/setup')
  totpSetup(@CurrentActor() a: RequestActor) { return this.auth.totpSetup(a); }

  @Post('totp/enable') @HttpCode(204)
  async totpEnable(@CurrentActor() a: RequestActor, @Body(new ZodPipe(codeSchema)) b: z.infer<typeof codeSchema>) { await this.auth.totpEnable(a, b.code); }

  private async assertCanManage(a: RequestActor, sessionId: string) {
    const owner = await this.auth.sessionOwner(a, sessionId);
    if (owner !== a.userId && !can(a, 'users', 'edit', { branchId: null })) throw new ForbiddenException();
  }
}
