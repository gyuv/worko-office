import { Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';

export type AccessClaims = { sub: string; tid: string; sid: string; dev: string };

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

  async verify(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.key, { issuer: 'worko', algorithms: ['HS256'] });
    return { sub: payload.sub!, tid: payload.tid as string, sid: payload.sid as string, dev: payload.dev as string };
  }
}
