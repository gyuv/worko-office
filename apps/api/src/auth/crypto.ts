import { createHash, createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, len: number, o: object) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Format: scrypt$N$r$p$salt$hash (base64). Pure Node — no native build step on Windows desktops/CI. */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const h = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: +N!, r: +r!, p: +p!, maxmem: SCRYPT.maxmem });
  return timingSafeEqual(h, expected);
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const numericCode = (digits = 6) => String(randomInt(0, 10 ** digits)).padStart(digits, '0');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, val = 0, out = '';
  for (const byte of buf) {
    val = (val << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0, val = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits) — compatible with Google Authenticator etc. */
export function totp(secret: Buffer, at = Date.now(), step = 30, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / step)));
  const h = createHmac('sha1', secret).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  const code = (h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/** Accepts ±1 step for clock drift. Returns the matched time step (for replay protection) or null. */
export function verifyTotp(secret: Buffer, code: string, at = Date.now()): number | null {
  for (const d of [-1, 0, 1]) {
    const t = at + d * 30_000;
    if (totp(secret, t) === code) return Math.floor(t / 30_000);
  }
  return null;
}
