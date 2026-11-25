import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { detectServer, type ServerType } from './detect';
import { jarJavaMajor } from './diagnose';
import { readInstallMeta } from './installmeta';
import { Properties } from './properties';
import { javaForMc } from './providers';

export interface Inspection {
  dir: string;
  exists: boolean;
  isDirectory: boolean;
  software: { type: ServerType; version: string | null; jar: string | null } | null;
  /** Java the server needs, if known. */
  javaMajor: number | null;
  eula: 'accepted' | 'declined' | 'missing';
  properties: { port: number | null; ip: string; onlineMode: boolean | null; motd: string | null; levelName: string | null } | null;
  /** Folders that contain a world (level.dat). */
  worlds: string[];
  plugins: string[];
  mods: number;
  /** Size of everything in the folder (counting stops after a few hundred thousand files). */
  sizeBytes: number;
  managedByMcli: boolean;
  files: { velocityToml: boolean; paperGlobal: boolean; forwardingSecret: boolean };
  /** Things the user should know before this server joins a network. */
  warnings: string[];
}

const MAX_ENTRIES = 300_000;

/** Total size of a folder; symbolic links are not followed. */
async function folderSize(dir: string): Promise<number> {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < MAX_ENTRIES) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue; // unreadable folder: skip it
    }
    for (const e of entries) {
      seen++;
      const path = join(current, e.name);
      if (e.isDirectory()) stack.push(path);
      else if (e.isFile()) total += (await stat(path).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

const jars = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.jar')).sort();
  } catch {
    return []; // no such folder
  }
};

/** Minecraft version of an existing server when the jar name does not say: Paper's history file, then the log. */
function versionFromFiles(dir: string): string | null {
  try {
    const history = readFileSync(join(dir, 'version_history.json'), 'utf8');
    const m = /\(MC: ([\d.]+)\)/.exec(history);
    if (m) return m[1];
  } catch {
    // no history file
  }
  try {
    const log = readFileSync(join(dir, 'logs', 'latest.log'), 'utf8');
    const m = /Starting minecraft server version ([\d.]+)/.exec(log);
    if (m) return m[1];
  } catch {
    // no log
  }
  return null;
}

/** Looks into a folder that may hold a Minecraft server and says what it is and what to watch out for. Changes nothing. */
export async function inspectFolder(dir: string): Promise<Inspection> {
  const base: Inspection = {
    dir,
    exists: existsSync(dir),
    isDirectory: false,
    software: null,
    javaMajor: null,
    eula: 'missing',
    properties: null,
    worlds: [],
    plugins: [],
    mods: 0,
    sizeBytes: 0,
    managedByMcli: false,
    files: { velocityToml: false, paperGlobal: false, forwardingSecret: false },
    warnings: [],
  };
  if (!base.exists) return { ...base, warnings: ['This folder does not exist.'] };
  base.isDirectory = statSync(dir).isDirectory();
  if (!base.isDirectory) return { ...base, warnings: ['This is a file, not a folder.'] };

  const det = detectServer(dir);
  if (det) {
    const version = det.mcVersion ?? versionFromFiles(dir);
    base.software = { type: det.type, version: version ?? null, jar: det.jar ?? null };
    const jarMajor = det.jar ? jarJavaMajor(join(dir, det.jar)) : undefined;
    const known = jarMajor ?? readInstallMeta(dir)?.javaMajor ?? (det.type === 'velocity' ? 17 : version ? javaForMc(version) : undefined);
    base.javaMajor = known ?? null;
  } else {
    base.warnings.push('No Minecraft server was found in this folder (no server jar).');
  }
  base.managedByMcli = existsSync(join(dir, 'mcli-install.json'));

  const eulaFile = join(dir, 'eula.txt');
  if (existsSync(eulaFile)) base.eula = /eula\s*=\s*true/i.test(readFileSync(eulaFile, 'utf8')) ? 'accepted' : 'declined';

  const props = new Properties(dir);
  if (props.exists) {
    const port = Number(props.get('server-port'));
    const online = props.get('online-mode');
    base.properties = {
      port: Number.isInteger(port) && port > 0 ? port : null,
      ip: props.get('server-ip') ?? '',
      onlineMode: online === undefined ? null : online.trim() === 'true',
      motd: props.get('motd') ?? null,
      levelName: props.get('level-name') ?? null,
    };
  }

  const level = base.properties?.levelName || 'world';
  const candidates = new Set([level, `${level}_nether`, `${level}_the_end`]);
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && existsSync(join(dir, e.name, 'level.dat'))) candidates.add(e.name);
  } catch {
    // unreadable folder: no worlds listed
  }
  base.worlds = [...candidates].filter((w) => existsSync(join(dir, w, 'level.dat'))).sort();
  base.plugins = jars(join(dir, 'plugins'));
  base.mods = jars(join(dir, 'mods')).length;
  base.files = {
    velocityToml: existsSync(join(dir, 'velocity.toml')),
    paperGlobal: existsSync(join(dir, 'config', 'paper-global.yml')),
    forwardingSecret: existsSync(join(dir, 'forwarding.secret')),
  };
  base.sizeBytes = await folderSize(dir);

  if (base.software?.type === 'spigot') base.warnings.push('Spigot cannot receive players from Velocity securely. MCNetwork can switch it to Paper (your plugins and world stay).');
  if (base.software && ['fabric', 'forge', 'neoforge', 'vanilla'].includes(base.software.type)) base.warnings.push(`${base.software.type} servers cannot receive players from Velocity without extra mods. They can be managed, but not placed behind the proxy.`);
  if (base.properties?.onlineMode === false && base.software?.type !== 'velocity') base.warnings.push('This server runs in offline mode. Behind Velocity (online mode) players get their real Mojang UUIDs, so existing player data (inventories, homes, permissions) may no longer match.');
  if (base.mods > 0 && base.software?.type === 'paper') base.warnings.push('The mods folder is ignored by Paper.');
  return base;
}
