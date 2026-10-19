import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { backupDirOf, type Config } from './config';
import { Properties } from './properties';
import { createZip, extractZip } from './zip';

export interface BackupInfo {
  name: string;
  path: string;
  size: number;
  mtime: Date;
}

/** What the backup manager needs from the running server (provided by Core). */
export interface ServerHooks {
  isRunning(): boolean;
  isStopped(): boolean;
  send(command: string): boolean;
  /** Resolves true when a console line matching `re` appears, false on timeout. */
  waitForLine(re: RegExp, timeoutMs: number): Promise<boolean>;
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Events: 'change' (list or busy state changed), 'info' (text). */
export class BackupManager extends EventEmitter {
  /** Human readable progress while an operation runs, otherwise null. */
  busy: string | null = null;
  lastBackupAt: number | null = null;

  constructor(
    private cfg: Config,
    private hooks: ServerHooks,
  ) {
    super();
  }

  get dir(): string {
    return backupDirOf(this.cfg);
  }

  /** World folders that exist on disk: level-name plus the Paper-style _nether/_the_end folders. */
  worldFolders(): string[] {
    const level = new Properties(this.cfg.serverDir).get('level-name') || 'world';
    return [level, `${level}_nether`, `${level}_the_end`].filter((f) => existsSync(join(this.cfg.serverDir, f)));
  }

  async list(): Promise<BackupInfo[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((n) => n.toLowerCase().endsWith('.zip'));
    } catch {
      return [];
    }
    const out: BackupInfo[] = [];
    for (const name of names) {
      const path = join(this.dir, name);
      const s = await stat(path);
      out.push({ name, path, size: s.size, mtime: s.mtime });
    }
    return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }

  private setBusy(text: string | null): void {
    this.busy = text;
    this.emit('change');
  }

  /** Creates a backup. If the server runs, world saving is paused (save-off) while zipping. */
  async create(): Promise<BackupInfo | null> {
    if (this.busy) {
      this.emit('info', `Backup busy: ${this.busy}`);
      return null;
    }
    const folders = this.worldFolders();
    if (!folders.length) {
      this.emit('info', 'Backup failed: no world folder found (start the server once to generate it).');
      return null;
    }
    const running = this.hooks.isRunning();
    let savingOff = false;
    this.setBusy('Preparing...');
    try {
      if (running) {
        this.hooks.send('save-off');
        savingOff = true;
        this.setBusy('Flushing world to disk...');
        this.hooks.send('save-all flush');
        const saved = await this.hooks.waitForLine(/Saved the (game|world)|Saved the world/i, 60_000);
        if (!saved) this.emit('info', 'Warning: no save confirmation from the server, continuing anyway.');
      }
      const name = `backup-${stamp()}.zip`;
      const out = join(this.dir, name);
      this.setBusy('Zipping 0%');
      const result = await createZip(out, this.cfg.serverDir, folders, (p) => {
        const pct = p.totalBytes ? Math.floor((p.doneBytes / p.totalBytes) * 100) : 100;
        const text = `Zipping ${pct}%`;
        if (text !== this.busy) this.setBusy(text);
      });
      const s = await stat(out);
      this.lastBackupAt = Date.now();
      const skipped = result.skipped ? ` (${result.skipped} locked files skipped)` : '';
      this.emit('info', `Backup created: ${name} (${(s.size / 1048576).toFixed(1)} MB)${skipped}`);
      await this.prune();
      return { name, path: out, size: s.size, mtime: s.mtime };
    } catch (err) {
      this.emit('info', `Backup failed: ${(err as Error).message}`);
      return null;
    } finally {
      if (savingOff && this.hooks.isRunning()) this.hooks.send('save-on');
      this.setBusy(null);
    }
  }

  /** Deletes the oldest backups beyond cfg.backupKeep. */
  async prune(): Promise<void> {
    if (this.cfg.backupKeep <= 0) return;
    const all = await this.list();
    for (const old of all.slice(this.cfg.backupKeep)) {
      await rm(old.path, { force: true });
      this.emit('info', `Removed old backup ${old.name}`);
    }
  }

  async remove(name: string): Promise<void> {
    await rm(join(this.dir, name), { force: true });
    this.emit('info', `Deleted backup ${name}`);
    this.emit('change');
  }

  /** Restores a backup. The server must be stopped; current worlds are renamed, not deleted. */
  async restore(name: string): Promise<boolean> {
    if (this.busy) return false;
    if (!this.hooks.isStopped()) {
      this.emit('info', 'Stop the server before restoring a backup.');
      return false;
    }
    this.setBusy('Restoring...');
    try {
      const safety = `pre-restore-${stamp()}`;
      for (const folder of this.worldFolders()) {
        await rename(join(this.cfg.serverDir, folder), join(this.cfg.serverDir, `${folder}.${safety}`));
      }
      await mkdir(this.cfg.serverDir, { recursive: true });
      const files = await extractZip(join(this.dir, name), this.cfg.serverDir);
      this.emit('info', `Restored ${name} (${files} files). Previous worlds were renamed to *.${safety}.`);
      return true;
    } catch (err) {
      this.emit('info', `Restore failed: ${(err as Error).message}`);
      return false;
    } finally {
      this.setBusy(null);
    }
  }
}
