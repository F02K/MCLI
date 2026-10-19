import { execFile } from 'node:child_process';
import { closeSync, openSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { crc32, listZipEntries, readEntryRaw, readZipFileSync } from './zip';

export type ProblemAction = 'eula' | 'settings' | 'versions' | 'java' | 'java-install' | 'backups';

export interface Problem {
  id: string;
  title: string;
  advice: string;
  /** Fatal problems stop automatic crash restarts (restarting cannot fix them). */
  fatal: boolean;
  action?: ProblemAction;
  /** For action 'java-install': the Java major version that should be installed. */
  javaMajor?: number;
}

interface Rule extends Omit<Problem, 'id'> {
  id: string;
  re: RegExp;
}

const RULES: Rule[] = [
  {
    id: 'eula',
    re: /agree to the EULA|You need to agree to the EULA/i,
    title: 'The Minecraft EULA is not accepted',
    advice: 'Accept the EULA to run the server (Dashboard: press E, or Versions: E).',
    fatal: true,
    action: 'eula',
  },
  {
    id: 'port',
    re: /Failed to bind to port|Address already in use|FAILED TO BIND TO PORT/i,
    title: 'The server port is already in use',
    advice: 'Another program (or another server) uses this port. Stop it or change server-port in Settings.',
    fatal: true,
    action: 'settings',
  },
  {
    id: 'java-old',
    re: /UnsupportedClassVersionError|Unsupported class file major version|compiled by a more recent version of the Java Runtime/i,
    title: 'Java is too old for this server',
    advice: 'Install a newer Java and point "java" in Settings > MCLI to it.',
    fatal: true,
    action: 'java',
  },
  {
    id: 'jar-broken',
    re: /Invalid or corrupt jarfile|Unable to access jarfile|no main manifest attribute|Could not find or load main class|java\.util\.zip\.ZipException|Error: Invalid or corrupt/i,
    title: 'The server jar is missing or broken',
    advice: 'Reinstall it from the Versions tab (R = repair).',
    fatal: true,
    action: 'versions',
  },
  {
    id: 'oom',
    re: /java\.lang\.OutOfMemoryError|Could not reserve enough space|insufficient memory for the Java Runtime/i,
    title: 'Not enough memory for the server',
    advice: 'Lower maxMemory (the machine has too little RAM) or raise it (the server needs more), in Settings > MCLI.',
    fatal: false,
    action: 'settings',
  },
  {
    id: 'world',
    re: /Failed to load (level|chunk)|Exception reading .+\.mc[ar]|Failed to read level\.dat/i,
    title: 'The world could not be loaded',
    advice: 'The world may be corrupted. Restore a backup in the Backups tab.',
    fatal: false,
    action: 'backups',
  },
  {
    id: 'mods',
    re: /Incompatible mod set|Mod resolution failed|Missing or unsupported mandatory dependencies|ModResolutionException/i,
    title: 'A mod or plugin problem prevents the start',
    advice: 'Check the console for the named mod, then remove or update it in the mods folder.',
    fatal: true,
  },
  {
    id: 'watchdog',
    re: /Considering it to be crashed|BEGIN PRINTED THREAD DUMP/i,
    title: 'The server watchdog detected a freeze',
    advice: 'The server stopped ticking and was shut down. Check the console and consider more memory or fewer plugins.',
    fatal: false,
  },
];

/** Matches one server console line against the known failure patterns. */
export function diagnoseLine(line: string): Problem | null {
  for (const rule of RULES) {
    if (rule.re.test(line)) {
      const { re: _re, ...problem } = rule;
      if (rule.id === 'java-old') {
        // "class file version 69.0" / "major version 69" -> Java 25 (class file major = Java + 44)
        const n = Number(/(?:class file version|major version) (\d{2,3})/.exec(line)?.[1]);
        if (n >= 52 && n <= 100) {
          problem.javaMajor = n - 44;
          problem.title = `This server needs Java ${n - 44}`;
          problem.advice = `The Java that started it is too old. MCLI will use or offer Java ${n - 44}.`;
          problem.action = 'java-install';
        }
      }
      return problem;
    }
  }
  return null;
}

// ---------------------------------------------------------------- jar checks

export interface JarCheck {
  ok: boolean;
  problems: string[];
  mainClass?: string;
  entries: number;
  size: number;
}

const MIN_JAR_BYTES = 10 * 1024;

function manifestMain(jar: string): string | undefined {
  const mf = readZipFileSync(jar, 'META-INF/MANIFEST.MF')?.toString('utf8');
  return mf ? /^Main-Class:\s*(\S+)/m.exec(mf.replace(/\r?\n /g, ''))?.[1] : undefined;
}

/** Fast structural check: exists, plausible size, valid zip directory, manifest with Main-Class. */
export function quickCheckJar(path: string): JarCheck {
  const result: JarCheck = { ok: true, problems: [], entries: 0, size: 0 };
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { ...result, ok: false, problems: ['The file does not exist.'] };
  }
  result.size = size;
  if (size < MIN_JAR_BYTES) result.problems.push(`The file is only ${size} bytes - an unfinished or failed download.`);
  try {
    const fd = openSync(path, 'r');
    try {
      const entries = listZipEntries(fd);
      if (!entries) result.problems.push('Not a valid jar/zip file (truncated or corrupt).');
      else result.entries = entries.length;
    } finally {
      closeSync(fd);
    }
    if (result.entries > 0) {
      result.mainClass = manifestMain(path);
      if (!result.mainClass) result.problems.push('The jar has no Main-Class in its manifest.');
    }
  } catch (err) {
    result.problems.push(`Cannot read the jar: ${(err as Error).message}`);
  }
  result.ok = result.problems.length === 0;
  return result;
}

/** Thorough check: inflates every entry and compares size and CRC-32. Yields to the event loop. */
export async function deepCheckJar(path: string, onProgress?: (done: number, total: number) => void): Promise<JarCheck> {
  const quick = quickCheckJar(path);
  if (!quick.ok) return quick;
  const fd = openSync(path, 'r');
  const problems: string[] = [];
  try {
    const entries = listZipEntries(fd) ?? [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.name.endsWith('/')) continue;
      try {
        const raw = readEntryRaw(fd, e);
        const data = e.method === 8 ? inflateRawSync(raw) : raw;
        if (data.length !== e.size) problems.push(`${e.name}: wrong size`);
        else if (crc32(data) !== e.crc) problems.push(`${e.name}: checksum mismatch`);
      } catch (err) {
        problems.push(`${e.name}: ${(err as Error).message}`);
      }
      if (problems.length >= 5) break;
      if (i % 50 === 0) {
        onProgress?.(i, entries.length);
        await new Promise((r) => setImmediate(r));
      }
    }
  } finally {
    closeSync(fd);
  }
  return { ...quick, ok: problems.length === 0, problems };
}

/** Java version Minecraft itself asks for, read from the jar's version.json (newer jars). */
export function jarJavaMajor(path: string): number | undefined {
  try {
    const json = readZipFileSync(path, 'version.json')?.toString('utf8');
    if (!json) return undefined;
    const v = JSON.parse(json) as { java_version?: number; java_component?: string; javaVersion?: { majorVersion: number } };
    return typeof v.java_version === 'number' ? v.java_version : v.javaVersion?.majorVersion;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- java

export interface JavaInfo {
  major: number;
  raw: string;
  /** Temurin, Zulu, Corretto, Microsoft, Oracle, OpenJDK, ... */
  vendor: string;
}

const VENDORS: [string, RegExp][] = [
  ['Temurin', /Temurin/i],
  ['Zulu', /Zulu/i],
  ['Corretto', /Corretto/i],
  ['Microsoft', /Microsoft/i],
  ['GraalVM', /GraalVM/i],
  ['Semeru', /Semeru/i],
  ['Liberica', /Liberica/i],
  ['SapMachine', /SapMachine/i],
  ['Oracle', /Java\(TM\)|Oracle/i],
  ['OpenJDK', /OpenJDK/i],
];

function vendorOf(text: string): string {
  return VENDORS.find(([, re]) => re.test(text))?.[0] ?? 'Java';
}

const javaCache = new Map<string, Promise<JavaInfo | null>>();

/** Runs `java -version` and parses the major version (8, 17, 21, ...). Cached per command. */
export function getJavaInfo(command: string): Promise<JavaInfo | null> {
  let cached = javaCache.get(command);
  if (!cached) {
    cached = new Promise((resolve) => {
      try {
        execFile(command, ['-version'], { timeout: 10_000, windowsHide: true }, (err, stdout, stderr) => {
          resolve(err ? null : parseJavaVersion(`${stderr}${stdout}`));
        });
      } catch {
        resolve(null); // spawn can throw synchronously for files that are not executable
      }
    });
    javaCache.set(command, cached);
  }
  return cached;
}

/** Parses the output of `java -version` ("1.8.0_392" means Java 8, "21.0.8" means Java 21). */
export function parseJavaVersion(text: string): JavaInfo | null {
  const m = /version "(\d+)(?:\.(\d+))?[^"]*"/.exec(text);
  if (!m) return null;
  const major = m[1] === '1' ? Number(m[2] ?? 8) : Number(m[1]);
  return { major, raw: m[0].replace('version ', '').replace(/"/g, ''), vendor: vendorOf(text) };
}

export function forgetJavaInfo(): void {
  javaCache.clear();
}
