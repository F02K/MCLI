import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { VERSION } from './version';

const USER_AGENT = `MCLI/${VERSION}`;
const IDLE_TIMEOUT_MS = 30_000;

export async function fetchText(url: string, timeoutMs = 15_000): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export async function fetchJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  return JSON.parse(await fetchText(url, timeoutMs)) as T;
}

export interface DownloadOptions {
  sha1?: string;
  sha256?: string;
  /** Expected size in bytes (used when the server sends no Content-Length). */
  size?: number;
  onProgress?: (done: number, total: number) => void;
  /** Abort when no data arrives for this long (default 30 s). */
  idleMs?: number;
}

export interface DownloadResult {
  size: number;
  sha256: string;
}

/**
 * Downloads `url` to `dest` (via dest + ".part"), verifies size and checksums and only then
 * moves it into place. A stalled connection aborts after 30 s without data.
 */
export async function downloadFile(url: string, dest: string, opts: DownloadOptions = {}): Promise<DownloadResult> {
  const controller = new AbortController();
  const idleMs = opts.idleMs ?? IDLE_TIMEOUT_MS;
  let idle = setTimeout(() => controller.abort(), idleMs);
  const bump = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), idleMs);
  };
  const partial = dest + '.part';
  await mkdir(dirname(dest), { recursive: true });
  const fh = await open(partial, 'w');
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
    const total = Number(res.headers.get('content-length')) || opts.size || 0;
    const sha1 = createHash('sha1');
    const sha256 = createHash('sha256');
    let done = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bump();
      await fh.write(chunk);
      sha1.update(chunk);
      sha256.update(chunk);
      done += chunk.length;
      opts.onProgress?.(done, total);
    }
    await fh.close();
    const got1 = sha1.digest('hex');
    const got256 = sha256.digest('hex');
    if (done === 0) throw new Error('Download was empty');
    if (total && done !== total) throw new Error(`Incomplete download (${done} of ${total} bytes)`);
    if (opts.sha256 && opts.sha256.toLowerCase() !== got256) throw new Error('SHA-256 checksum mismatch - the download is corrupt');
    if (opts.sha1 && opts.sha1.toLowerCase() !== got1) throw new Error('SHA-1 checksum mismatch - the download is corrupt');
    await rm(dest, { force: true });
    await rename(partial, dest);
    return { size: done, sha256: got256 };
  } catch (err) {
    await fh.close().catch(() => {});
    await rm(partial, { force: true });
    if (controller.signal.aborted) throw new Error(`Download stalled (no data for ${Math.round(idleMs / 1000)} seconds)`);
    if ((err as Error).message === 'terminated') throw new Error('Connection lost during the download');
    throw err;
  } finally {
    clearTimeout(idle);
  }
}
