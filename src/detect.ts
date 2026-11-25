import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readInstallMeta } from './installmeta';
import { readZipFileSync } from './zip';

export type ServerType = 'vanilla' | 'paper' | 'fabric' | 'forge' | 'neoforge' | 'velocity' | 'spigot';

export interface DetectedServer {
  type: ServerType;
  dir: string;
  mcVersion?: string;
  /** Arguments after `java <jvm-flags>`, e.g. ['-jar', 'paper.jar', 'nogui'] */
  launchArgs: string[];
  /** The jar that is launched with -jar (not set for Forge's args-file launcher). */
  jar?: string;
}

/** Reads META-INF/MANIFEST.MF from a jar without any external dependency. */
export function readManifest(jarPath: string): Record<string, string> | null {
  try {
    const data = readZipFileSync(jarPath, 'META-INF/MANIFEST.MF');
    if (!data) return null;
    const out: Record<string, string> = {};
    for (const line of data.toString('utf8').replace(/\r?\n /g, '').split(/\r?\n/)) {
      const idx = line.indexOf(': ');
      if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 2);
    }
    return out;
  } catch {
    return null; // not a readable jar
  }
}

function subdirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Modern Forge/NeoForge (1.17+) start via an args file instead of -jar. */
function detectArgsLauncher(dir: string): DetectedServer | null {
  const argsName = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
  const candidates: { type: ServerType; base: string[] }[] = [
    { type: 'neoforge', base: ['libraries', 'net', 'neoforged', 'neoforge'] },
    { type: 'forge', base: ['libraries', 'net', 'minecraftforge', 'forge'] },
  ];
  for (const { type, base } of candidates) {
    for (const ver of subdirs(join(dir, ...base))) {
      const rel = [...base, ver, argsName].join('/');
      if (!existsSync(join(dir, rel))) continue;
      const launchArgs = existsSync(join(dir, 'user_jvm_args.txt')) ? ['@user_jvm_args.txt', `@${rel}`] : [`@${rel}`];
      launchArgs.push('nogui');
      // Forge: "1.20.1-47.2.0", NeoForge: "21.1.50" (MC version not directly readable)
      const mcVersion = type === 'forge' ? ver.split('-')[0] : undefined;
      return { type, dir, mcVersion, launchArgs };
    }
  }
  return null;
}

const launch = (jar: string) => ['-jar', jar, 'nogui'];

/** Old Forge versions (<1.17): forge-<mc>-<forge>[-universal|-server].jar */
function detectLegacyForge(dir: string, jars: string[]): DetectedServer | null {
  const jar = jars.find((j) => /^forge-[\d.]+-[\d.]+.*\.jar$/i.test(j));
  if (!jar) return null;
  return { type: 'forge', dir, mcVersion: /^forge-([\d.]+)-/i.exec(jar)?.[1], launchArgs: launch(jar), jar };
}

export function detectServer(dir: string): DetectedServer | null {
  // What MCLI installed last is authoritative (several server jars may lie around).
  const meta = readInstallMeta(dir);
  if (meta) {
    if (meta.provider === 'forge') {
      const forge = detectArgsLauncher(dir);
      if (forge?.type === 'forge') return forge;
    } else if (existsSync(join(dir, meta.file))) {
      return { type: meta.provider, dir, mcVersion: meta.mcVersion, launchArgs: meta.provider === 'velocity' ? ['-jar', meta.file] : launch(meta.file), jar: meta.file };
    }
  }

  const modern = detectArgsLauncher(dir);
  if (modern) return modern;

  let files: string[];
  try {
    files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return null;
  }
  // newest jar first, so a freshly installed one wins over leftovers
  const jars = files
    .filter((f) => f.toLowerCase().endsWith('.jar') && !/installer/i.test(f))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .map((x) => x.f);
  const info = jars.map((jar) => ({ jar, main: readManifest(join(dir, jar))?.['Main-Class'] ?? '' }));

  const fabric = info.find((j) => j.main.startsWith('net.fabricmc.')) ?? info.find((j) => /^fabric-server/i.test(j.jar));
  if (fabric) {
    const v = /fabric-server-mc\.([\d.]+)/i.exec(fabric.jar)?.[1];
    return { type: 'fabric', dir, mcVersion: v, launchArgs: launch(fabric.jar), jar: fabric.jar };
  }

  const proxy = info.find((j) => j.main.startsWith('com.velocitypowered.')) ?? info.find((j) => /^velocity[-.]/i.test(j.jar));
  if (proxy) {
    // proxies have no "nogui" argument and no Minecraft version
    const v = /^velocity-([\d.]+(?:-SNAPSHOT)?)-\d+\.jar$/i.exec(proxy.jar)?.[1];
    return { type: 'velocity', dir, mcVersion: v, launchArgs: ['-jar', proxy.jar], jar: proxy.jar };
  }

  // Spigot/CraftBukkit have no download here (they come from BuildTools), but existing servers should be recognised
  const spigot = info.find((j) => j.main.startsWith('org.bukkit.craftbukkit.')) ?? info.find((j) => /^(spigot|craftbukkit)[-.]/i.test(j.jar));
  if (spigot) {
    const v = /^(?:spigot|craftbukkit)-([\d.]+)\.jar$/i.exec(spigot.jar)?.[1];
    return { type: 'spigot', dir, mcVersion: v, launchArgs: launch(spigot.jar), jar: spigot.jar };
  }

  const paper = info.find((j) => j.main.startsWith('io.papermc.paperclip.')) ?? info.find((j) => /^paper[-.]/i.test(j.jar));
  if (paper) {
    const v = /^paper-([\d.]+)-\d+\.jar$/i.exec(paper.jar)?.[1];
    return { type: 'paper', dir, mcVersion: v, launchArgs: launch(paper.jar), jar: paper.jar };
  }

  const legacy = detectLegacyForge(dir, jars);
  if (legacy) return legacy;

  const vanilla =
    info.find((j) => j.main.startsWith('net.minecraft.')) ??
    info.find((j) => /^(server|minecraft_server.*)\.jar$/i.test(j.jar));
  if (vanilla) {
    const v = /minecraft_server\.([\d.]+)\.jar$/i.exec(vanilla.jar)?.[1];
    return { type: 'vanilla', dir, mcVersion: v, launchArgs: launch(vanilla.jar), jar: vanilla.jar };
  }
  return null;
}
