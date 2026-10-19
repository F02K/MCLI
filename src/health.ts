import type { Core } from './core';
import { pingServer } from './ping';

export interface Health {
  /** null = not checked yet / server not running */
  reachable: boolean | null;
  everReachable: boolean;
  failures: number;
  latencyMs?: number;
  version?: string;
  motd?: string;
  online?: number;
  max?: number;
  host?: string;
  port?: number;
}

export const FROZEN_AFTER_FAILURES = 6; // 30 s without an answer at the default interval
export const DEFAULT_SLOW_START_MS = 5 * 60_000;

export const freshHealth = (): Health => ({ reachable: null, everReachable: false, failures: 0 });

/**
 * One health check: pings the server like the Minecraft server list does. A starting server that
 * answers is marked running; a running server that stopped answering is reported as a problem.
 */
export async function healthTick(core: Core): Promise<void> {
  const state = core.server.state;
  if (state !== 'starting' && state !== 'running') return;
  const props = core.properties;
  const port = Number(props.get('server-port') || 25565);
  let host = props.get('server-ip') || '127.0.0.1';
  if (host === '0.0.0.0') host = '127.0.0.1';
  try {
    const r = await pingServer(host, port);
    core.health = { reachable: true, everReachable: true, failures: 0, latencyMs: r.latencyMs, version: r.version, motd: r.motd, online: r.online, max: r.max, host, port };
    core.players.max = r.max;
    core.removeProblem('not-responding');
    core.removeProblem('slow-start');
    if (state === 'starting') {
      core.info(`Server answers on ${host}:${port} (${r.version}) - marking it as running.`);
      core.server.markRunning();
    }
  } catch {
    const h = core.health;
    core.health = { ...h, reachable: false, failures: h.failures + 1, host, port };
    if (state === 'running' && h.everReachable && core.health.failures >= FROZEN_AFTER_FAILURES) {
      core.addProblem({
        id: 'not-responding',
        title: 'The server is running but does not answer',
        advice: `No reply on port ${port} for ${Math.round((core.health.failures * core.healthMs) / 1000)}s. It may be frozen or overloaded - check the console, restart if needed.`,
        fatal: false,
      });
    }
    const started = core.server.startedAt;
    if (state === 'starting' && started && Date.now() - started > (core.opts.slowStartMs ?? DEFAULT_SLOW_START_MS)) {
      core.addProblem({
        id: 'slow-start',
        title: 'The server is taking very long to start',
        advice: 'Large worlds and modpacks can take minutes. If the console shows nothing new, stop and restart it.',
        fatal: false,
      });
    }
  }
  core.emit('health');
}
