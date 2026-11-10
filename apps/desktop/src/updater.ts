import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebStream } from 'node:stream/web';
import { DOWNLOAD_PREFIX, pickUpdate, RELEASES_API, type GhRelease, type UpdateInfo, type UpdatePlatform } from './update-core';

export type UpdateState =
  | { phase: 'idle' | 'checking' | 'current'; current: string; checkedAt?: string }
  | { phase: 'downloading'; current: string; info: UpdateInfo; progress: number }
  | { phase: 'ready'; current: string; info: UpdateInfo; file: string }
  | { phase: 'error'; current: string; message: string };

export const platformKey = (platform: NodeJS.Platform, arch: string): UpdatePlatform | null =>
  platform === 'win32' ? 'win' : platform === 'darwin' ? (arch === 'arm64' ? 'mac-arm64' : 'mac-x64') : platform === 'linux' ? 'linux' : null;

type Deps = { current: string; platform: UpdatePlatform; dir: string; fetch: typeof fetch; onState(s: UpdateState): void };

/** Checks GitHub Releases, downloads the installer in the background and verifies its SHA-256 before offering it. */
export class Updater {
  state: UpdateState;
  private busy = false;
  constructor(private d: Deps) { this.state = { phase: 'idle', current: d.current }; }
  private set(s: UpdateState) { this.state = s; this.d.onState(s); }

  async check(): Promise<UpdateState> {
    if (this.busy || this.state.phase === 'ready') return this.state;
    this.busy = true;
    try {
      this.set({ phase: 'checking', current: this.d.current });
      const res = await this.d.fetch(RELEASES_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Worko-Desktop' } });
      if (!res.ok) throw new Error(`release check failed (${res.status})`);
      const info = pickUpdate((await res.json()) as GhRelease[], this.d.platform, this.d.current);
      if (!info) { this.set({ phase: 'current', current: this.d.current, checkedAt: new Date().toISOString() }); return this.state; }
      const file = await this.download(info);
      this.set({ phase: 'ready', current: this.d.current, info, file });
    } catch (e) {
      this.set({ phase: 'error', current: this.d.current, message: (e as Error).message });
    } finally { this.busy = false; }
    return this.state;
  }

  private async download(info: UpdateInfo): Promise<string> {
    if (!info.url.startsWith(DOWNLOAD_PREFIX)) throw new Error('untrusted download host');
    mkdirSync(this.d.dir, { recursive: true });
    const file = join(this.d.dir, info.fileName);
    if (existsSync(file) && info.sha256 && (await sha256(file)) === info.sha256) return file; // already fetched earlier
    this.set({ phase: 'downloading', current: this.d.current, info, progress: 0 });
    const res = await this.d.fetch(info.url, { headers: { 'user-agent': 'Worko-Desktop' } });
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || info.size || 0;
    let got = 0; let last = 0;
    const body = Readable.fromWeb(res.body as unknown as WebStream);
    body.on('data', (c: Buffer) => {
      got += c.length;
      const p = total ? Math.min(99, Math.floor((got / total) * 100)) : 0;
      if (p >= last + 5) { last = p; this.set({ phase: 'downloading', current: this.d.current, info, progress: p }); }
    });
    await pipeline(body, createWriteStream(file));
    if (info.size && statSync(file).size !== info.size) { rmSync(file, { force: true }); throw new Error('download incomplete'); }
    if (info.sha256 && (await sha256(file)) !== info.sha256) { rmSync(file, { force: true }); throw new Error('checksum mismatch'); }
    return file;
  }
}

export async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}
