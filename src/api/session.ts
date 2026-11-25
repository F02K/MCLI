import type { Core, LogEntry } from '../core';
import { VERSION } from '../version';
import { METHODS } from './methods';
import { installerSnapshot, metricPoint, PROTOCOL_VERSION, playersSnapshot, problemsSnapshot, type ApiEvent, type ApiRequest, type ApiResponse } from './protocol';

/**
 * Newline-delimited JSON protocol for programs (like MCNetwork) that control one MCLI instance.
 * Requests: {"id":1,"method":"status","params":{}}; replies: {"id":1,"ok":true,"result":...} or
 * {"id":1,"ok":false,"error":"..."}; events (no id): {"event":"log","data":...}.
 * Transport-agnostic: `write` receives one JSON line at a time.
 */
export class ApiSession {
  constructor(
    private core: Core,
    private write: (line: string) => void,
  ) {}

  private send(msg: ApiResponse | ApiEvent): void {
    this.write(JSON.stringify(msg));
  }

  /** Subscribes to the core's events and announces the session. */
  attach(): void {
    const { core } = this;
    const ev = (event: string, data: () => unknown) => core.on(event, () => this.send({ event, data: data() }));
    core.on('log', (e: LogEntry) => this.send({ event: 'log', data: e }));
    core.on('state', (state: string) => this.send({ event: 'state', data: { state } }));
    ev('players', () => playersSnapshot(core));
    ev('problems', () => problemsSnapshot(core));
    ev('health', () => core.health);
    ev('installer', () => installerSnapshot(core));
    ev('backups', () => ({ busy: core.backups.busy, lastAt: core.backups.lastBackupAt ?? null }));
    core.metrics.on('sample', () => this.send({ event: 'sample', data: metricPoint(core) }));
    core.on('quitting', () => this.send({ event: 'quitting', data: {} }));
    this.send({ event: 'ready', data: { mcli: VERSION, protocol: PROTOCOL_VERSION, dir: core.cfg.serverDir } });
  }

  /** Handles one request line; always answers (a broken line gets id null). */
  async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let req: ApiRequest;
    try {
      req = JSON.parse(line) as ApiRequest;
    } catch {
      return this.send({ id: null, ok: false, error: 'Invalid JSON' });
    }
    const id = typeof req.id === 'number' || typeof req.id === 'string' ? req.id : null;
    const method = typeof req.method === 'string' ? METHODS[req.method] : undefined;
    if (!method) return this.send({ id, ok: false, error: `Unknown method "${String(req.method)}"` });
    try {
      const result = await method(this.core, req.params && typeof req.params === 'object' ? req.params : {});
      this.send({ id, ok: true, result: result ?? null });
    } catch (err) {
      this.send({ id, ok: false, error: (err as Error).message });
    }
  }
}
