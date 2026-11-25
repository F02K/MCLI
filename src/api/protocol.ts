import type { Core } from '../core';
import { VERSION } from '../version';

/** Version of the line protocol; increase it when a method or event changes incompatibly. */
export const PROTOCOL_VERSION = 1;

export interface ApiRequest {
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export type ApiResponse =
  | { id: number | string | null; ok: true; result: unknown }
  | { id: number | string | null; ok: false; error: string };

export interface ApiEvent {
  event: string;
  data: unknown;
}

/** One metrics point: what the dashboards graph. Memory in bytes, CPU in percent of the machine. */
export interface MetricPoint {
  time: number;
  sysCpu: number;
  sysMemPercent: number;
  procRss: number;
  procCpu: number;
}

const last = (a: number[]): number => a[a.length - 1] ?? 0;

export function metricPoint(core: Core): MetricPoint {
  const m = core.metrics;
  return { time: Date.now(), sysCpu: last(m.sysCpu), sysMemPercent: last(m.sysMem), procRss: last(m.procMem), procCpu: last(m.procCpu) };
}

export function playersSnapshot(core: Core) {
  const p = core.players;
  return { count: p.online.size, max: p.max ?? core.health.max ?? null, online: [...p.online].map(([name, since]) => ({ name, since })) };
}

export function problemsSnapshot(core: Core) {
  return core.problems.map((p) => ({ id: p.id, title: p.title, advice: p.advice, fatal: p.fatal }));
}

export function installerSnapshot(core: Core) {
  return { busy: core.installer.busy, progress: core.installer.progress };
}

/** Everything a dashboard needs to draw one server card. */
export function buildStatus(core: Core) {
  const { server, cfg } = core;
  const det = server.detect();
  const inst = core.installed();
  const running = server.state !== 'stopped';
  return {
    mcli: VERSION,
    protocol: PROTOCOL_VERSION,
    dir: cfg.serverDir,
    state: server.state,
    pid: server.pid ?? null,
    startedAt: running ? server.startedAt : null,
    uptimeMs: running && server.startedAt ? Date.now() - server.startedAt : 0,
    restarts: server.restarts,
    software: det ? { type: det.type, version: det.mcVersion ?? null, jar: det.jar ?? null, build: inst.identity ?? null } : null,
    java: core.currentJava(),
    memory: { min: cfg.minMemory, max: cfg.maxMemory, systemTotal: core.metrics.totalMem, ...metricPoint(core) },
    players: playersSnapshot(core),
    health: core.health,
    problems: problemsSnapshot(core),
    installer: installerSnapshot(core),
    backups: { busy: core.backups.busy, lastAt: core.backups.lastBackupAt ?? null },
    updates: core.updateInfo ? { checkedAt: core.updateInfo.checkedAt, error: core.updateInfo.error ?? null, sameMc: core.updateInfo.sameMc?.display ?? null, newerMc: core.updateInfo.newerMc ?? null } : null,
  };
}
