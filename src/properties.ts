import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type PropType = 'bool' | 'enum' | 'int' | 'string';

export interface PropMeta {
  type: PropType;
  options?: string[];
  desc: string;
}

/** Descriptions and value types for the well-known keys; unknown keys fall back to plain strings. */
export const PROP_META: Record<string, PropMeta> = {
  motd: { type: 'string', desc: 'Message shown in the server list.' },
  'max-players': { type: 'int', desc: 'Maximum number of players that can join at once.' },
  difficulty: { type: 'enum', options: ['peaceful', 'easy', 'normal', 'hard'], desc: 'Game difficulty.' },
  gamemode: { type: 'enum', options: ['survival', 'creative', 'adventure', 'spectator'], desc: 'Default game mode for new players.' },
  'force-gamemode': { type: 'bool', desc: 'Force players into the default game mode on every join.' },
  hardcore: { type: 'bool', desc: 'Players are banned on death.' },
  pvp: { type: 'bool', desc: 'Allow players to damage each other.' },
  'white-list': { type: 'bool', desc: 'Only whitelisted players can join.' },
  'enforce-whitelist': { type: 'bool', desc: 'Kick players that are not on the whitelist when it is reloaded.' },
  'online-mode': { type: 'bool', desc: 'Verify players with Mojang (disable only for offline/proxy setups).' },
  'server-port': { type: 'int', desc: 'TCP port the server listens on.' },
  'server-ip': { type: 'string', desc: 'IP to bind to; leave empty for all interfaces.' },
  'view-distance': { type: 'int', desc: 'Chunks sent to each player (3-32).' },
  'simulation-distance': { type: 'int', desc: 'Chunks around players that are ticked (3-32).' },
  'level-name': { type: 'string', desc: 'World folder name.' },
  'level-seed': { type: 'string', desc: 'World seed (only used when the world is generated).' },
  'level-type': { type: 'string', desc: 'World type, e.g. minecraft:normal or minecraft:flat.' },
  'allow-nether': { type: 'bool', desc: 'Enable the Nether.' },
  'allow-flight': { type: 'bool', desc: 'Do not kick players for flying (needed by some mods).' },
  'spawn-protection': { type: 'int', desc: 'Radius around spawn that only operators can modify.' },
  'spawn-monsters': { type: 'bool', desc: 'Spawn hostile mobs.' },
  'spawn-animals': { type: 'bool', desc: 'Spawn passive animals.' },
  'spawn-npcs': { type: 'bool', desc: 'Spawn villagers.' },
  'enable-command-block': { type: 'bool', desc: 'Allow command blocks.' },
  'enable-rcon': { type: 'bool', desc: 'Enable the remote console.' },
  'enable-query': { type: 'bool', desc: 'Enable the GameSpy4 query protocol.' },
  'enable-status': { type: 'bool', desc: 'Show the server as online in the server list.' },
  'op-permission-level': { type: 'int', desc: 'Default permission level for operators (1-4).' },
  'player-idle-timeout': { type: 'int', desc: 'Minutes before idle players are kicked (0 = never).' },
  'max-tick-time': { type: 'int', desc: 'Milliseconds a tick may take before the watchdog stops the server (-1 = off).' },
  'network-compression-threshold': { type: 'int', desc: 'Packet size above which packets are compressed (-1 = off).' },
  'resource-pack': { type: 'string', desc: 'URL of a server resource pack.' },
  'require-resource-pack': { type: 'bool', desc: 'Kick players that decline the resource pack.' },
  'sync-chunk-writes': { type: 'bool', desc: 'Write chunks synchronously (safer, slightly slower).' },
  'use-native-transport': { type: 'bool', desc: 'Use optimized networking on Linux.' },
  'enable-jmx-monitoring': { type: 'bool', desc: 'Expose JMX monitoring beans.' },
  'rate-limit': { type: 'int', desc: 'Max packets per second per player before kick (0 = off).' },
  'broadcast-console-to-ops': { type: 'bool', desc: 'Send console command output to online operators.' },
  'broadcast-rcon-to-ops': { type: 'bool', desc: 'Send RCON command output to online operators.' },
  'generate-structures': { type: 'bool', desc: 'Generate villages, temples etc. (only for new chunks).' },
  'text-filtering-config': { type: 'string', desc: 'Chat filtering configuration.' },
};

export function metaFor(key: string, value: string): PropMeta {
  const known = PROP_META[key];
  if (known) return known;
  if (value === 'true' || value === 'false') return { type: 'bool', desc: 'Custom or unknown property.' };
  return { type: 'string', desc: 'Custom or unknown property.' };
}

export interface PropEntry {
  key: string;
  value: string;
}

/** Reads and writes server.properties while preserving comments, order and unknown lines. */
export class Properties {
  readonly path: string;
  private lines: string[] = [];
  exists = false;

  constructor(serverDir: string) {
    this.path = join(serverDir, 'server.properties');
    this.reload();
  }

  reload(): void {
    this.exists = existsSync(this.path);
    this.lines = this.exists ? readFileSync(this.path, 'utf8').split(/\r?\n/) : [];
    if (this.lines.length && this.lines[this.lines.length - 1] === '') this.lines.pop();
  }

  private parse(line: string): PropEntry | null {
    if (!line || line.startsWith('#') || line.startsWith('!')) return null;
    const idx = line.indexOf('=');
    if (idx < 1) return null;
    return { key: line.slice(0, idx).trim(), value: line.slice(idx + 1) };
  }

  entries(): PropEntry[] {
    return this.lines.map((l) => this.parse(l)).filter((e): e is PropEntry => e !== null);
  }

  get(key: string): string | undefined {
    return this.entries().find((e) => e.key === key)?.value;
  }

  set(key: string, value: string): void {
    const idx = this.lines.findIndex((l) => this.parse(l)?.key === key);
    if (idx >= 0) this.lines[idx] = `${key}=${value}`;
    else this.lines.push(`${key}=${value}`);
    writeFileSync(this.path, this.lines.join('\n') + '\n');
    this.exists = true;
  }
}
