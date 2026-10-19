import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { forgetJavaInfo, getJavaInfo, type JavaInfo } from './diagnose';
import { downloadFile, fetchJson } from './net';
import { extractZip } from './zip';

export type JavaSource = 'JAVA_HOME' | 'PATH' | 'system' | 'MCLI' | 'Minecraft';

export interface JavaInstall {
  /** The java executable. */
  path: string;
  home: string;
  major: number;
  raw: string;
  vendor: string;
  source: JavaSource;
  isJdk: boolean;
}

const SOURCE_RANK: Record<JavaSource, number> = { JAVA_HOME: 0, PATH: 1, system: 2, MCLI: 3, Minecraft: 4 };
const EXE = process.platform === 'win32' ? 'java.exe' : 'java';
const JAVAC = process.platform === 'win32' ? 'javac.exe' : 'javac';
const MAX_WALK = 4000;

function hasJava(home: string): boolean {
  return existsSync(join(home, 'bin', EXE));
}

function subdirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Finds Java homes (folders with bin/java) below `root`, at most `depth` levels deep. */
function findHomes(root: string, depth: number, budget = { left: MAX_WALK }): string[] {
  if (budget.left-- <= 0) return [];
  if (hasJava(root)) return [root];
  const mac = join(root, 'Contents', 'Home'); // macOS .jdk bundles
  if (hasJava(mac)) return [mac];
  if (depth <= 0) return [];
  return subdirs(root).slice(0, 200).flatMap((d) => findHomes(join(root, d), depth - 1, budget));
}

interface Candidate {
  home: string;
  source: JavaSource;
}

function systemRoots(): { root: string; depth: number; source: JavaSource }[] {
  const env = process.env;
  const home = homedir();
  const roots: { root: string; depth: number; source: JavaSource }[] = [];
  const add = (root: string | undefined, depth: number, source: JavaSource = 'system') => {
    if (root) roots.push({ root, depth, source });
  };
  if (process.platform === 'win32') {
    for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]) {
      if (!pf) continue;
      for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru', 'AdoptOpenJDK', 'OpenJDK', 'GraalVM', 'Temurin', 'Android/Android Studio/jbr']) {
        add(join(pf, vendor), 2);
      }
    }
    add(env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'), 3);
    add(join(home, '.jdks'), 2);
    add(join(home, '.gradle', 'jdks'), 2);
    add(join(home, 'scoop', 'apps'), 3);
    add(env.APPDATA && join(env.APPDATA, '.minecraft', 'runtime'), 4, 'Minecraft');
    if (env.LOCALAPPDATA) {
      const pkgs = join(env.LOCALAPPDATA, 'Packages');
      for (const p of subdirs(pkgs).filter((n) => n.startsWith('Microsoft.4297127D64EC6'))) add(join(pkgs, p, 'LocalCache', 'Local', 'runtime'), 4, 'Minecraft');
    }
  } else if (process.platform === 'darwin') {
    add('/Library/Java/JavaVirtualMachines', 1);
    add(join(home, 'Library', 'Java', 'JavaVirtualMachines'), 1);
    add('/opt/homebrew/opt', 4);
    add('/usr/local/opt', 4);
    add(join(home, '.sdkman', 'candidates', 'java'), 1);
    add(join(home, '.jdks'), 2);
    add(join(home, 'Library', 'Application Support', 'minecraft', 'runtime'), 4, 'Minecraft');
  } else {
    for (const r of ['/usr/lib/jvm', '/usr/lib64/jvm', '/usr/java', '/usr/local/java', '/opt/java', '/usr/local/lib/jvm']) add(r, 2);
    add(join(home, '.sdkman', 'candidates', 'java'), 1);
    add(join(home, '.jdks'), 2);
    add(join(home, '.gradle', 'jdks'), 2);
    add(join(home, '.minecraft', 'runtime'), 4, 'Minecraft');
  }
  return roots;
}

function gather(managedDir: string): Candidate[] {
  const out: Candidate[] = [];
  const javaHome = process.env.JAVA_HOME;
  if (javaHome && hasJava(javaHome)) out.push({ home: javaHome, source: 'JAVA_HOME' });
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (existsSync(join(dir, EXE))) out.push({ home: dirname(dir), source: 'PATH' });
  }
  for (const { root, depth, source } of systemRoots()) {
    for (const home of findHomes(root, depth)) out.push({ home, source });
  }
  for (const home of findHomes(managedDir, 4)) out.push({ home, source: 'MCLI' });
  return out;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Finds all Java installations on this machine (and the ones MCLI installed itself). */
export async function scanJava(managedDir: string, infoOf: (exe: string) => Promise<JavaInfo | null> = getJavaInfo): Promise<JavaInstall[]> {
  const seen = new Set<string>();
  const unique: Candidate[] = [];
  for (const c of gather(managedDir)) {
    const key = canonical(join(c.home, 'bin', EXE)).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }
  const infos = await Promise.all(
    unique.map(async (c): Promise<JavaInstall | null> => {
      const path = join(c.home, 'bin', EXE);
      const info: JavaInfo | null = await infoOf(path);
      if (!info) return null;
      return { path, home: c.home, major: info.major, raw: info.raw, vendor: info.vendor, source: c.source, isJdk: existsSync(join(c.home, 'bin', JAVAC)) };
    }),
  );
  return infos
    .filter((i): i is JavaInstall => i !== null)
    .sort((a, b) => a.major - b.major || SOURCE_RANK[a.source] - SOURCE_RANK[b.source]);
}

/**
 * Chooses the best install for a server: the lowest version that is at least `min` (and at most `max`).
 * Without a requirement it prefers Java 21, then 17, then the newest.
 */
export function pickJava(installs: JavaInstall[], min?: number, max = Infinity): JavaInstall | undefined {
  const ok = installs.filter((i) => (min === undefined || i.major >= min) && i.major <= max);
  const byRank = (a: JavaInstall, b: JavaInstall) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  if (min !== undefined) return [...ok].sort((a, b) => a.major - b.major || byRank(a, b))[0];
  for (const preferred of [21, 17]) {
    const hit = ok.filter((i) => i.major === preferred).sort(byRank)[0];
    if (hit) return hit;
  }
  return [...ok].sort((a, b) => b.major - a.major || byRank(a, b))[0];
}

// ---------------------------------------------------------------- download + install (Eclipse Temurin)

export interface JavaPlan {
  major: number;
  release: string;
  name: string;
  url: string;
  size: number;
  sha256: string;
  imageType: 'jre' | 'jdk';
}

interface AdoptiumAsset {
  release_name: string;
  binary: { package: { link: string; name: string; size: number; checksum: string } };
}

export const ADOPTIUM = 'https://api.adoptium.net/v3';
const FALLBACK_MAJORS = [8, 11, 17, 21, 25];

const OS: Partial<Record<NodeJS.Platform, string>> = { win32: 'windows', linux: 'linux', darwin: 'mac' };
const ARCH: Partial<Record<string, string>> = { x64: 'x64', arm64: 'aarch64', ia32: 'x86' };

export interface JavaManagerOptions {
  api?: string;
  /** Verifies an installed java executable; replaced in tests. */
  verify?: (exe: string) => Promise<JavaInfo | null>;
}

/** Scans for Java and installs missing versions into <config folder>/java/<major>. Emits 'change'. */
export class JavaManager extends EventEmitter {
  installs: JavaInstall[] = [];
  scanned = false;
  busy: string | null = null;
  progress: { done: number; total: number } | null = null;
  readonly dir: string;

  constructor(
    configDir: string,
    private log: (text: string) => void,
    private opts: JavaManagerOptions = {},
  ) {
    super();
    this.dir = join(configDir, 'java');
  }

  async scan(): Promise<JavaInstall[]> {
    forgetJavaInfo();
    this.installs = await scanJava(this.dir, this.opts.verify);
    this.scanned = true;
    this.emit('change');
    return this.installs;
  }

  find(min?: number, max?: number): JavaInstall | undefined {
    return pickJava(this.installs, min, max);
  }

  /** Major versions offered for installation (LTS releases). */
  async availableMajors(): Promise<number[]> {
    try {
      const info = await fetchJson<{ available_lts_releases: number[] }>(`${this.opts.api ?? ADOPTIUM}/info/available_releases`);
      return info.available_lts_releases.length ? info.available_lts_releases : FALLBACK_MAJORS;
    } catch {
      return FALLBACK_MAJORS;
    }
  }

  async plan(major: number): Promise<JavaPlan> {
    const os = OS[process.platform];
    const arch = ARCH[process.arch];
    if (!os || !arch) throw new Error(`No Java download for ${process.platform}/${process.arch}`);
    for (const imageType of ['jre', 'jdk'] as const) {
      const url = `${this.opts.api ?? ADOPTIUM}/assets/latest/${major}/hotspot?architecture=${arch}&image_type=${imageType}&os=${os}&vendor=eclipse`;
      let assets: AdoptiumAsset[] = [];
      try {
        assets = await fetchJson<AdoptiumAsset[]>(url);
      } catch (err) {
        if (imageType === 'jdk') throw err;
      }
      const pkg = assets[0]?.binary.package;
      if (pkg) return { major, release: assets[0].release_name, name: pkg.name, url: pkg.link, size: pkg.size, sha256: pkg.checksum, imageType };
    }
    throw new Error(`Eclipse Temurin has no Java ${major} for this system`);
  }

  private setBusy(text: string | null): void {
    this.busy = text;
    if (!text) this.progress = null;
    this.emit('change');
  }

  /** Downloads, verifies, extracts and checks a Temurin build. Resolves the new install or null. */
  async install(major: number): Promise<JavaInstall | null> {
    if (this.busy) {
      this.log(`Java installer busy: ${this.busy}`);
      return null;
    }
    const tmp = join(this.dir, `.tmp-${major}`);
    const target = join(this.dir, String(major));
    try {
      this.setBusy(`Looking up Java ${major}...`);
      const plan = await this.plan(major);
      const archive = join(this.dir, '.downloads', plan.name);
      let last = 0;
      this.setBusy(`Downloading ${plan.name}`);
      await downloadFile(plan.url, archive, {
        sha256: plan.sha256,
        size: plan.size,
        onProgress: (done, total) => {
          this.progress = { done, total };
          if (Date.now() - last > 150) {
            last = Date.now();
            this.busy = `Downloading Java ${major}: ${(done / 1048576).toFixed(0)} of ${(total / 1048576).toFixed(0)} MB`;
            this.emit('change');
          }
        },
      });
      this.log(`Downloaded ${plan.name} (SHA-256 verified)`);

      this.setBusy(`Extracting Java ${major}...`);
      this.guard(tmp);
      this.guard(target);
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true });
      if (plan.name.endsWith('.zip')) await extractZip(archive, tmp);
      else await run('tar', ['-xzf', archive, '-C', tmp]);
      await rm(archive, { force: true });

      if (!findHomes(tmp, 4).length) throw new Error('The archive does not contain a Java runtime');
      await rm(target, { recursive: true, force: true });
      await rename(tmp, target);
      const home = findHomes(target, 4)[0];
      const exe = join(home, 'bin', EXE);
      const info = await (this.opts.verify ?? getJavaInfo)(exe);
      if (!info || info.major !== major) throw new Error(`The installed Java does not run correctly (expected ${major}, got ${info?.major ?? 'nothing'})`);
      this.log(`Installed Java ${info.raw} (${plan.release}) in ${target}`);
      await this.scan();
      return this.installs.find((i) => canonical(i.path).toLowerCase() === canonical(exe).toLowerCase()) ?? null;
    } catch (err) {
      this.log(`Java install failed: ${(err as Error).message}`);
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      return null;
    } finally {
      this.setBusy(null);
    }
  }

  /** Refuses to delete anything outside MCLI's own java folder. */
  private guard(path: string): void {
    const root = resolve(this.dir) + sep;
    if (!(resolve(path) + sep).startsWith(root)) throw new Error(`Refusing to touch ${path}`);
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    execFile(cmd, args, { timeout: 5 * 60_000 }, (err, _out, stderr) => (err ? rej(new Error(`${cmd} failed: ${stderr || err.message}`)) : res()));
  });
}

/** Java versions a server accepts. Old Forge (Minecraft <= 1.16) only runs on exactly Java 8. */
export function javaRange(provider: string | undefined, required: number | undefined): { min?: number; max?: number } {
  if (provider === 'forge' && required === 8) return { min: 8, max: 8 };
  return { min: required };
}
