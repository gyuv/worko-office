import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { canonical } from './audit/audit.service.js';
import { base32Decode, base32Encode, hashPassword, totp, verifyPassword, verifyTotp } from './auth/crypto.js';
import { decryptField, encryptField } from './auth/field-crypto.js';
import { uuidv7 } from './db/ids.js';

describe('crypto', () => {
  it('TOTP matches RFC 6238 SHA-1 vectors (8-digit truncated to 6)', () => {
    const secret = Buffer.from('12345678901234567890');
    // RFC 6238 Appendix B: T=59 → 94287082, T=1111111109 → 07081804
    expect(totp(secret, 59_000)).toBe('287082');
    expect(totp(secret, 1_111_111_109_000)).toBe('081804');
    expect(verifyTotp(secret, totp(secret, 1_000_000), 1_030_000)).toBe(33); // time step 1_000_000 / 30s
    expect(verifyTotp(secret, totp(secret, 1_000_000), 1_200_000)).toBeNull();
  });
  it('base32 round-trips', () => {
    const b = Buffer.from('hello worko 2fa!');
    expect(base32Decode(base32Encode(b))).toEqual(b);
  });
  it('scrypt passwords verify and reject', async () => {
    const h = await hashPassword('s3cret-pass');
    expect(await verifyPassword('s3cret-pass', h)).toBe(true);
    expect(await verifyPassword('nope', h)).toBe(false);
    expect(h).not.toContain('s3cret');
  });
  it('field encryption is authenticated and bound to its AAD', () => {
    const blob = encryptField('ABCDE1234F', 'vault:1');
    expect(decryptField(blob, 'vault:1').toString()).toBe('ABCDE1234F');
    expect(() => decryptField(blob, 'vault:2')).toThrow();
  });
});

describe('ids & audit canonical form', () => {
  it('uuidv7 is time-ordered and versioned', () => {
    const a = uuidv7(1_700_000_000_000); const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
    expect(a[14]).toBe('7');
  });
  it('canonical JSON sorts keys deeply', () => {
    expect(canonical({ b: 1, a: { d: [2, { z: 1, y: 0 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":0,"z":1}]},"b":1}');
  });
});
