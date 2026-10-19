import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { detectServer } from './detect';
import { quickCheckJar } from './diagnose';
import { writeInstallMeta } from './installmeta';
import { downloadFile } from './net';
import type { DownloadPlan, ProviderId } from './providers';

export interface InstallerDeps {
  serverDir: string;
  isStopped(): boolean;
  /** True when world folders exist (a backup makes sense). */
  hasWorlds(): boolean;
  /** Creates a world backup; resolves true on success. */
  backup(): Promise<boolean>;
  javaCommand(): string;
  log(text: string): void;
  onInstalled(): void;
  /** Runs a process and resolves when it exits with 0 (replaced in tests). */
  run?: (command: string, args: string[], cwd: string, onLine: (line: string) => void) => Promise<void>;
}

const OLD_DIR = 'old-jars';

/** Jar name patterns that belong to a server "family"; leftovers of other families are retired. */
const FAMILIES: Record<ProviderId, RegExp[]> = {
  vanilla: [/^paper-.*\.jar$/i, /^fabric-server.*\.jar$/i, /^minecraft_server.*\.jar$/i, /^server\.jar$/i, /^forge-.*\.jar$/i],
  paper: [/^paper-.*\.jar$/i, /^fabric-server.*\.jar$/i, /^minecraft_server.*\.jar$/i, /^server\.jar$/i, /^forge-.*\.jar$/i],
  fabric: [/^paper-.*\.jar$/i, /^fabric-server.*\.jar$/i, /^minecraft_server.*\.jar$/i, /^server\.jar$/i, /^forge-.*\.jar$/i],
  forge: [/^paper-.*\.jar$/i, /^fabric-server.*\.jar$/i], // forge needs the vanilla jar next to it
};

function runProcess(command: string, args: string[], cwd: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) onLine(line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => reject(new Error(`could not start ${command}: ${e.message}`)));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit code ${code}`))));
  });
}

function fmt(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

/** Downloads and installs server software. Emits 'change' while busy text/progress update. */
export class Installer extends EventEmitter {
  busy: string | null = null;
  progress: { done: number; total: number } | null = null;

  constructor(private deps: InstallerDeps) {
    super();
  }

  private setBusy(text: string | null): void {
    this.busy = text;
    if (!text) this.progress = null;
    this.emit('change');
  }

  async install(plan: DownloadPlan, opts: { backupFirst: boolean }): Promise<boolean> {
    const { deps } = this;
    if (this.busy) {
      deps.log(`Installer busy: ${this.busy}`);
      return false;
    }
    if (!deps.isStopped()) {
      deps.log('Stop the server before installing.');
      return false;
    }
    try {
      if (opts.backupFirst && deps.hasWorlds()) {
        this.setBusy('Creating a backup first...');
        if (!(await deps.backup())) throw new Error('The backup failed, install cancelled to keep your world safe');
      }

      const dest = join(deps.serverDir, plan.filename);
      const staged = `${dest}.new`; // validated first, only then it replaces a jar with the same name
      let lastEmit = 0;
      this.setBusy(`Downloading ${plan.filename}`);
      const result = await downloadFile(plan.url, staged, {
        sha1: plan.sha1,
        sha256: plan.sha256,
        size: plan.size,
        onProgress: (done, total) => {
          this.progress = { done, total };
          const now = Date.now();
          if (now - lastEmit > 120) {
            lastEmit = now;
            this.busy = `Downloading ${plan.filename} - ${fmt(done)}${total ? ` of ${fmt(total)}` : ''}`;
            this.emit('change');
          }
        },
      });
      const verified = plan.sha256 || plan.sha1 ? 'checksum verified' : 'no checksum published';
      deps.log(`Downloaded ${plan.filename} (${fmt(result.size)}, ${verified})`);

      const check = quickCheckJar(staged);
      if (!check.ok) {
        await rm(staged, { force: true });
        throw new Error(`The downloaded jar is broken: ${check.problems.join(' ')}`);
      }
      if (plan.kind === 'jar') {
        await rm(dest, { force: true });
        await rename(staged, dest);
      } else {
        await rename(staged, dest);
        await this.runForgeInstaller(dest);
        await rm(dest, { force: true });
      }

      await this.retireOld(plan);
      writeInstallMeta(deps.serverDir, {
        provider: plan.provider,
        mcVersion: plan.mcVersion,
        identity: plan.identity,
        file: plan.filename,
        javaMajor: plan.javaMajor,
        sha256: result.sha256,
        installedAt: new Date().toISOString(),
      });
      deps.onInstalled();
      if (!detectServer(deps.serverDir)) throw new Error('Installed, but the server could not be detected afterwards');
      deps.log(`Installed ${plan.display}.`);
      return true;
    } catch (err) {
      deps.log(`Install failed: ${(err as Error).message}`);
      return false;
    } finally {
      this.setBusy(null);
    }
  }

  /** Runs `java -jar forge-installer.jar --installServer` in the server folder. */
  private async runForgeInstaller(installerJar: string): Promise<void> {
    this.setBusy('Running the Forge installer (downloads libraries, can take a few minutes)...');
    let tail = '';
    const onLine = (line: string) => {
      tail = line;
      this.deps.log(`[forge-installer] ${line}`);
    };
    const run = this.deps.run ?? runProcess;
    try {
      await run(this.deps.javaCommand(), ['-jar', installerJar, '--installServer'], this.deps.serverDir, onLine);
    } catch (err) {
      throw new Error(`Forge installer failed: ${(err as Error).message}${tail ? ` (${tail})` : ''}`);
    }
  }

  /** Moves leftover server jars of the old installation into old-jars/ so they cannot be picked up. */
  private async retireOld(plan: DownloadPlan): Promise<void> {
    const { serverDir } = this.deps;
    const patterns = FAMILIES[plan.provider];
    const moved: string[] = [];
    for (const name of await readdir(serverDir)) {
      if (name === plan.filename || !name.toLowerCase().endsWith('.jar')) continue;
      if (!patterns.some((re) => re.test(name))) continue;
      if (plan.provider === 'forge' && /installer/i.test(name)) continue;
      await mkdir(join(serverDir, OLD_DIR), { recursive: true });
      let target = join(serverDir, OLD_DIR, name);
      for (let i = 1; existsSync(target); i++) target = join(serverDir, OLD_DIR, `${i}-${name}`);
      await rename(join(serverDir, name), target);
      moved.push(name);
    }
    if (moved.length) this.deps.log(`Moved previous server jar(s) to ${OLD_DIR}/: ${moved.join(', ')}`);
  }
}
