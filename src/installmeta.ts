import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Remembers what MCLI installed last, so detection and update checks stay exact. */
export interface InstallMeta {
  provider: 'vanilla' | 'paper' | 'fabric' | 'forge';
  mcVersion: string;
  identity: string;
  /** The launch jar for vanilla/paper/fabric; the installer name for forge. */
  file: string;
  javaMajor?: number;
  sha256?: string;
  installedAt: string;
}

export const INSTALL_META_FILE = 'mcli-install.json';

export function readInstallMeta(serverDir: string): InstallMeta | null {
  const file = join(serverDir, INSTALL_META_FILE);
  if (!existsSync(file)) return null;
  try {
    const meta = JSON.parse(readFileSync(file, 'utf8')) as InstallMeta;
    return meta && typeof meta.provider === 'string' && typeof meta.file === 'string' ? meta : null;
  } catch {
    return null;
  }
}

export function writeInstallMeta(serverDir: string, meta: InstallMeta): void {
  writeFileSync(join(serverDir, INSTALL_META_FILE), JSON.stringify(meta, null, 2) + '\n');
}
