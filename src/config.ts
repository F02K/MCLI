import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface Config {
  /** Folder that contains the Minecraft server (default: current folder). */
  serverDir: string;
  /** Path to the java executable; empty = MCLI finds a fitting Java automatically. */
  java: string;
  /** Download and install a missing Java version without asking (Eclipse Temurin). */
  javaAutoInstall: boolean;
  /** JVM heap settings, e.g. "1G". Ignored for Forge/NeoForge (use user_jvm_args.txt). */
  minMemory: string;
  maxMemory: string;
  autoRestart: boolean;
  maxRestarts: number;
  /** Where backups are stored; empty = "<serverDir>/backups". */
  backupDir: string;
  /** Automatic backup every N minutes while the server runs; 0 = off. */
  backupIntervalMinutes: number;
  /** Number of backups to keep (oldest are deleted); 0 = keep all. */
  backupKeep: number;
  /** Overrides detection and java entirely, e.g. { "command": "node", "args": ["fake.js"] }. */
  customLaunch?: { command: string; args: string[] };
  /** Folder that holds mcli.json (not stored in the file). */
  configDir: string;
}

/** Keys that can be edited from the UI and written back to mcli.json. */
export type EditableConfigKey =
  | 'java'
  | 'javaAutoInstall'
  | 'minMemory'
  | 'maxMemory'
  | 'autoRestart'
  | 'maxRestarts'
  | 'backupIntervalMinutes'
  | 'backupKeep';

const defaults: Omit<Config, 'configDir'> = {
  serverDir: '.',
  java: '',
  javaAutoInstall: false,
  minMemory: '1G',
  maxMemory: '2G',
  autoRestart: true,
  maxRestarts: 3,
  backupDir: '',
  backupIntervalMinutes: 0,
  backupKeep: 10,
};

export const CONFIG_FILE = 'mcli.json';

function readRaw(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Cannot parse ${file}: ${(err as Error).message}`);
  }
}

export function loadConfig(baseDir: string): Config {
  const user = readRaw(join(baseDir, CONFIG_FILE)) as Partial<Config>;
  const cfg: Config = { ...defaults, ...user, configDir: baseDir };
  cfg.serverDir = resolve(baseDir, cfg.serverDir);
  return cfg;
}

export function backupDirOf(cfg: Config): string {
  return cfg.backupDir ? resolve(cfg.configDir, cfg.backupDir) : join(cfg.serverDir, 'backups');
}

/** Updates one value in memory and in mcli.json (other keys in the file are preserved). */
export function saveConfigValue(cfg: Config, key: EditableConfigKey, value: string | number | boolean): void {
  const file = join(cfg.configDir, CONFIG_FILE);
  const raw = readRaw(file);
  raw[key] = value;
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  (cfg as unknown as Record<string, unknown>)[key] = value;
}
