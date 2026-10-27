import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

/** Subset of Electron's safeStorage (DPAPI on Windows, Keychain on macOS, libsecret on Linux). */
export type SafeStorage = { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string };

/**
 * Tokens are only ever written encrypted by the OS keystore. If encryption is unavailable (e.g. Linux without
 * a keyring) we keep them in memory only — the user signs in again after restart rather than storing plaintext.
 */
export class TokenStore {
  private memory: unknown = null;
  constructor(private file: string, private safe: SafeStorage) {}

  get(): unknown {
    if (!this.safe.isEncryptionAvailable()) return this.memory;
    if (!existsSync(this.file)) return null;
    try { return JSON.parse(this.safe.decryptString(readFileSync(this.file))); } catch { return null; }
  }

  set(v: unknown): void {
    this.memory = v;
    if (!this.safe.isEncryptionAvailable()) return;
    if (v === null) rmSync(this.file, { force: true });
    else writeFileSync(this.file, this.safe.encryptString(JSON.stringify(v)), { mode: 0o600 });
  }
}

/**
 * 32-byte key for the renderer's encrypted local store, generated once and kept encrypted by the OS keychain.
 * Without OS encryption the key lives in memory only, so local data can't outlive the process unprotected.
 */
export class DbKeyStore {
  private memory: Buffer | null = null;
  constructor(private file: string, private safe: SafeStorage, private random: (n: number) => Buffer) {}

  get(): Buffer {
    if (!this.safe.isEncryptionAvailable()) return (this.memory ??= this.random(32));
    if (existsSync(this.file)) {
      try { return Buffer.from(this.safe.decryptString(readFileSync(this.file)), 'base64'); } catch { /* corrupt → regenerate (old data unreadable, re-sync) */ }
    }
    const key = this.random(32);
    writeFileSync(this.file, this.safe.encryptString(key.toString('base64')), { mode: 0o600 });
    return key;
  }

  /** Remote wipe: destroying the key makes any leftover local data unreadable. */
  destroy() { this.memory = null; rmSync(this.file, { force: true }); }
}
