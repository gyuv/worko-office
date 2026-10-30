import { Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';

export type AccessClaims = { sub: string; tid: string; sid: string; dev: string };
export type VerifiedClaims = AccessClaims & { exp: number };
/** Portal access token: different issuer AND audience, so it can never verify as a staff token (and vice versa). */
export type PortalClaims = { sub: string; tid: string; sid: string };
const PORTAL_ISSUER = 'worko-portal';
/** Platform operator (super-admin) and support-impersonation tokens: their own issuer + audience each (D178, D180). */
export type PlatformClaims = { sub: string; sid: string };
export type ImpersonationClaims = { sub: string; sid: string; tid: string; gid: string; exp: number };
const PLATFORM_ISSUER = 'worko-platform';
const PLATFORM_AUDIENCE = 'platform-console';
const IMP_ISSUER = 'worko-impersonation';
const IMP_AUDIENCE = 'tenant-support';
export const PLATFORM_TTL_S = 30 * 60;
const PORTAL_AUDIENCE = 'client-portal';

@Injectable()
export class TokenService {
  private readonly key = new TextEncoder().encode(TokenService.secret());
  static readonly ACCESS_TTL_S = 15 * 60;
  static readonly REFRESH_TTL_DAYS = 30;

  private static secret(): string {
    const s = process.env.JWT_SIGNING_KEY;
    if (!s && process.env.NODE_ENV === 'production') throw new Error('JWT_SIGNING_KEY is required');
    return s ?? 'worko-dev-only-signing-key';
  }

  sign(c: AccessClaims): Promise<string> {
    return new SignJWT({ tid: c.tid, sid: c.sid, dev: c.dev }).setProtectedHeader({ alg: 'HS256' })
      .setSubject(c.sub).setIssuedAt().setIssuer('worko').setExpirationTime(`${TokenService.ACCESS_TTL_S}s`).sign(this.key);
  }

  async verify(token: string): Promise<VerifiedClaims> {
    const { payload } = await jwtVerify(token, this.key, { issuer: 'worko', algorithms: ['HS256'] });
    if (payload.aud !== undefined) throw new Error('unexpected audience');
    return { sub: payload.sub!, tid: payload.tid as string, sid: payload.sid as string, dev: payload.dev as string, exp: payload.exp! };
  }

  signPortal(c: PortalClaims): Promise<string> {
    return new SignJWT({ tid: c.tid, sid: c.sid, kind: 'portal' }).setProtectedHeader({ alg: 'HS256' })
      .setSubject(c.sub).setIssuedAt().setIssuer(PORTAL_ISSUER).setAudience(PORTAL_AUDIENCE).setExpirationTime(`${TokenService.ACCESS_TTL_S}s`).sign(this.key);
  }

  async verifyPortal(token: string): Promise<PortalClaims> {
    const { payload } = await jwtVerify(token, this.key, { issuer: PORTAL_ISSUER, audience: PORTAL_AUDIENCE, algorithms: ['HS256'] });
    if (payload.kind !== 'portal') throw new Error('not a portal token');
    return { sub: payload.sub!, tid: payload.tid as string, sid: payload.sid as string };
  }

  signPlatform(c: PlatformClaims): Promise<string> {
    return new SignJWT({ sid: c.sid, kind: 'platform' }).setProtectedHeader({ alg: 'HS256' })
      .setSubject(c.sub).setIssuedAt().setIssuer(PLATFORM_ISSUER).setAudience(PLATFORM_AUDIENCE).setExpirationTime(`${PLATFORM_TTL_S}s`).sign(this.key);
  }

  async verifyPlatform(token: string): Promise<PlatformClaims> {
    const { payload } = await jwtVerify(token, this.key, { issuer: PLATFORM_ISSUER, audience: PLATFORM_AUDIENCE, algorithms: ['HS256'] });
    if (payload.kind !== 'platform') throw new Error('not a platform token');
    return { sub: payload.sub!, sid: payload.sid as string };
  }

  signImpersonation(c: Omit<ImpersonationClaims, 'exp'>, expiresAt: Date): Promise<string> {
    return new SignJWT({ sid: c.sid, tid: c.tid, gid: c.gid, kind: 'impersonation' }).setProtectedHeader({ alg: 'HS256' })
      .setSubject(c.sub).setIssuedAt().setIssuer(IMP_ISSUER).setAudience(IMP_AUDIENCE).setExpirationTime(Math.floor(expiresAt.getTime() / 1000)).sign(this.key);
  }

  async verifyImpersonation(token: string): Promise<ImpersonationClaims> {
    const { payload } = await jwtVerify(token, this.key, { issuer: IMP_ISSUER, audience: IMP_AUDIENCE, algorithms: ['HS256'] });
    if (payload.kind !== 'impersonation') throw new Error('not an impersonation token');
    return { sub: payload.sub!, sid: payload.sid as string, tid: payload.tid as string, gid: payload.gid as string, exp: payload.exp! };
  }
}
