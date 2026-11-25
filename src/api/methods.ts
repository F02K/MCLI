import { saveConfigValue, type EditableConfigKey } from '../config';
import type { Core } from '../core';
import { inspectFolder } from '../inspect';
import { readList, type ListKind } from '../players';
import type { ProviderId } from '../providers';
import { buildStatus, installerSnapshot, metricPoint, playersSnapshot, problemsSnapshot } from './protocol';

type Params = Record<string, unknown>;
export type Method = (core: Core, params: Params) => unknown;

/** Settings a client may change, and the type each value must have. */
const SETTINGS: Record<EditableConfigKey, 'string' | 'number' | 'boolean'> = {
  java: 'string',
  javaAutoInstall: 'boolean',
  minMemory: 'string',
  maxMemory: 'string',
  autoRestart: 'boolean',
  maxRestarts: 'number',
  backupIntervalMinutes: 'number',
  backupKeep: 'number',
};

const MEMORY_RE = /^(\d+)([MG])$/i;
const LISTS: ListKind[] = ['whitelist', 'ops', 'banned-players', 'banned-ips'];

function str(p: Params, key: string): string {
  const v = p[key];
  if (typeof v !== 'string' || !v) throw new Error(`"${key}" (string) is required`);
  return v;
}

const megabytes = (v: string): number => {
  const m = MEMORY_RE.exec(v);
  if (!m) throw new Error(`Memory must look like "512M" or "2G", got "${v}"`);
  return Number(m[1]) * (m[2].toUpperCase() === 'G' ? 1024 : 1);
};

function provider(core: Core, id: string): ProviderId {
  if (!core.provider(id)) throw new Error(`Unknown provider "${id}"`);
  return id as ProviderId;
}

/** JVM heap for the next start. A running JVM cannot change its heap, so this never restarts anything. */
function setMemory(core: Core, p: Params): unknown {
  const min = p.min === undefined ? core.cfg.minMemory : str(p, 'min');
  const max = p.max === undefined ? core.cfg.maxMemory : str(p, 'max');
  if (megabytes(min) > megabytes(max)) throw new Error('The minimum memory cannot be larger than the maximum');
  if (min !== core.cfg.minMemory) saveConfigValue(core.cfg, 'minMemory', min);
  if (max !== core.cfg.maxMemory) saveConfigValue(core.cfg, 'maxMemory', max);
  return { min, max, appliesOnNextStart: core.server.state !== 'stopped' };
}

function setSetting(core: Core, p: Params): unknown {
  const key = str(p, 'key') as EditableConfigKey;
  const kind = SETTINGS[key];
  if (!kind) throw new Error(`Unknown setting "${key}"`);
  if (typeof p.value !== kind) throw new Error(`"${key}" must be a ${kind}`);
  if (key === 'minMemory' || key === 'maxMemory') return setMemory(core, { [key === 'minMemory' ? 'min' : 'max']: p.value });
  saveConfigValue(core.cfg, key, p.value as string | number | boolean);
  return { key, value: p.value };
}

export const METHODS: Record<string, Method> = {
  ping: () => 'pong',
  status: (core) => buildStatus(core),
  start: async (core) => {
    await core.startServer();
    return { state: core.server.state, problems: problemsSnapshot(core) };
  },
  stop: async (core) => {
    if (core.server.state !== 'stopped') await core.server.stop();
    return { state: core.server.state };
  },
  restart: async (core) => {
    await core.restartServer();
    return { state: core.server.state, problems: problemsSnapshot(core) };
  },
  /** Types a line into the server console; false when the server is not running. */
  command: (core, p) => core.server.send(str(p, 'text')),
  /** Same as typing into MCLI: ":commands" are MCLI's, anything else goes to the server. */
  exec: (core, p) => {
    core.exec(str(p, 'text'));
    return true;
  },
  logs: (core, p) => {
    const limit = typeof p.limit === 'number' ? Math.max(1, Math.min(5000, p.limit)) : 200;
    const since = typeof p.since === 'number' ? p.since : 0;
    return core.logs.filter((l) => l.time > since).slice(-limit);
  },
  players: (core) => playersSnapshot(core),
  list: (core, p) => {
    const kind = str(p, 'kind') as ListKind;
    if (!LISTS.includes(kind)) throw new Error(`"kind" must be one of ${LISTS.join(', ')}`);
    return readList(core.cfg.serverDir, kind);
  },
  metrics: (core) => {
    const m = core.metrics;
    return { current: metricPoint(core), totalMem: m.totalMem, history: { sysCpu: m.sysCpu, sysMem: m.sysMem, procMem: m.procMem, procCpu: m.procCpu } };
  },
  settings: (core) => ({ ...Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, (core.cfg as unknown as Record<string, unknown>)[k]])) }),
  setSetting,
  setMemory,
  versions: async (core, p) => {
    const prov = core.providers[provider(core, str(p, 'provider'))];
    return prov.versions(p.snapshots === true);
  },
  /** What a folder holds (server software, version, world, plugins, warnings) without touching it: for importing existing servers. */
  inspect: (_core, p) => inspectFolder(str(p, 'dir')),
  /** What an install would download (name, build, channel, needed Java) without installing anything. */
  plan: async (core, p) => {
    const plan = await core.providers[provider(core, str(p, 'provider'))].plan(str(p, 'version'));
    return { provider: plan.provider, version: plan.mcVersion, build: plan.identity, channel: plan.channel ?? null, javaMajor: plan.javaMajor ?? null, filename: plan.filename, size: plan.size ?? null, display: plan.display };
  },
  install: async (core, p) => core.installVersion(provider(core, str(p, 'provider')), str(p, 'version'), p.backupFirst !== false),
  update: (core, p) => core.update(p.latest === true),
  checkUpdates: (core) => core.checkUpdates(),
  installer: (core) => installerSnapshot(core),
  backup: async (core) => {
    const b = await core.backups.create();
    return b ? { name: b.name, size: b.size } : null;
  },
  backups: async (core) => (await core.backups.list()).map((b) => ({ name: b.name, size: b.size, mtime: b.mtime.getTime() })),
  acceptEula: (core) => {
    core.acceptEula();
    return true;
  },
  installJava: (core, p) => core.installJava(typeof p.major === 'number' ? p.major : 21),
  shutdown: (core) => {
    void core.shutdown();
    return true;
  },
};
