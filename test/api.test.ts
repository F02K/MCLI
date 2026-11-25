import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ApiSession } from '../src/api/session';
import { customLaunch, makeCore, tmp, waitFor } from './helpers';

interface Msg {
  id?: number | string | null;
  ok?: boolean;
  result?: unknown;
  error?: string;
  event?: string;
  data?: unknown;
}

interface Status {
  state: string;
  pid: number;
  uptimeMs: number;
  players: { count: number };
  memory: { max: string; systemTotal: number };
}
interface PlayerList {
  online: { name: string }[];
}
interface Metrics {
  totalMem: number;
  history: { sysMem: number[] };
}

/** The result of a reply, typed by the caller. */
const res = <T>(m: Msg): T => m.result as T;
const data = <T>(m: Msg | undefined): T => m?.data as T;

function rig(cfg: Record<string, unknown> = {}) {
  const dir = tmp('api');
  const core = makeCore(dir, { ...customLaunch(dir), ...cfg });
  const out: Msg[] = [];
  const session = new ApiSession(core, (line) => out.push(JSON.parse(line) as Msg));
  session.attach();
  let n = 0;
  const call = async (method: string, params?: Record<string, unknown>): Promise<Msg> => {
    const id = ++n;
    await session.handleLine(JSON.stringify({ id, method, params }));
    const reply = out.find((m) => m.id === id);
    assert.ok(reply, `no reply to ${method}`);
    return reply;
  };
  const events = (name: string) => out.filter((m) => m.event === name);
  return { dir, core, out, session, call, events };
}

describe('API session', () => {
  it('announces itself and answers ping and status', async () => {
    const { call, events, dir } = rig();
    assert.equal(data<{ protocol: number }>(events('ready')[0]).protocol, 1);
    assert.equal(data<{ dir: string }>(events('ready')[0]).dir, dir);
    assert.equal((await call('ping')).result, 'pong');
    const status = res<Status>(await call('status'));
    assert.equal(status.state, 'stopped');
    assert.equal(status.players.count, 0);
    assert.equal(status.memory.max, '2G');
    assert.ok(status.memory.systemTotal > 0);
  });

  it('reports bad input without crashing', async () => {
    const { session, out, call } = rig();
    await session.handleLine('not json');
    await session.handleLine('   ');
    await session.handleLine(JSON.stringify({ id: 'x', method: 'nope' }));
    await session.handleLine(JSON.stringify({ method: 5 }));
    assert.deepEqual(out.filter((m) => m.ok === false).map((m) => m.error), ['Invalid JSON', 'Unknown method "nope"', 'Unknown method "5"']);
    assert.equal(out.find((m) => m.id === 'x')?.ok, false);
    const r = await call('command', {});
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /"text".*required/);
  });

  it('starts and stops the server and streams events', async () => {
    const { call, core, events } = rig();
    assert.equal((await call('start')).ok, true);
    await waitFor(() => core.server.state === 'running', 5000, 'running');
    assert.ok(events('state').some((e) => data<{ state: string }>(e).state === 'running'));
    assert.ok(events('log').some((e) => /Done \(/.test(data<{ text: string }>(e).text)));

    assert.equal((await call('command', { text: 'join Steve' })).result, true);
    await waitFor(() => core.players.online.has('Steve'), 3000, 'player');
    const players = res<PlayerList>(await call('players'));
    assert.deepEqual(players.online.map((p) => p.name), ['Steve']);
    assert.ok(events('players').length > 0);
    const status = res<Status>(await call('status'));
    assert.equal(status.state, 'running');
    assert.ok(status.uptimeMs >= 0);
    assert.ok(status.pid > 0);

    const logs = res<unknown[]>(await call('logs', { limit: 5 }));
    assert.ok(logs.length > 0 && logs.length <= 5);
    assert.equal(res<unknown[]>(await call('logs', { since: Date.now() + 10_000 })).length, 0);

    assert.equal(res<Status>(await call('stop')).state, 'stopped');
    assert.equal((await call('command', { text: 'list' })).result, false);
  });

  it('exec runs MCLI commands and sends everything else to the server', async () => {
    const { call, core } = rig();
    await call('exec', { text: ':status' });
    assert.ok(core.logs.some((l) => /state: stopped/.test(l.text)));
    await call('exec', { text: 'hello' });
    assert.ok(core.logs.some((l) => /Server is not running/.test(l.text)));
  });

  it('sets the JVM memory with validation and persists it in mcli.json', async () => {
    const { call, dir, core } = rig();
    const ok = await call('setMemory', { min: '512M', max: '3G' });
    assert.deepEqual(ok.result, { min: '512M', max: '3G', appliesOnNextStart: false });
    assert.equal(core.cfg.maxMemory, '3G');
    assert.equal((JSON.parse(readFileSync(join(dir, 'mcli.json'), 'utf8')) as { minMemory: string }).minMemory, '512M');
    assert.match((await call('setMemory', { min: '4G' })).error ?? '', /minimum.*larger/);
    assert.match((await call('setMemory', { max: 'lots' })).error ?? '', /Memory must look like/);
    assert.equal((await call('setSetting', { key: 'maxMemory', value: '1G' })).ok, true); // goes through setMemory
    assert.equal(core.cfg.maxMemory, '1G');
  });

  it('changes whitelisted settings with type checks', async () => {
    const { call, core } = rig();
    assert.equal((await call('setSetting', { key: 'autoRestart', value: false })).ok, true);
    assert.equal(core.cfg.autoRestart, false);
    assert.match((await call('setSetting', { key: 'autoRestart', value: 'no' })).error ?? '', /must be a boolean/);
    assert.match((await call('setSetting', { key: 'serverDir', value: '/' })).error ?? '', /Unknown setting/);
    const settings = res<Record<string, unknown>>(await call('settings'));
    assert.equal(settings.autoRestart, false);
    assert.equal('configDir' in settings, false);
  });

  it('exposes metrics history, lists, backups and versions input checks', async () => {
    const { call, core } = rig();
    await core.metrics.sample();
    const m = res<Metrics>(await call('metrics'));
    assert.ok(m.totalMem > 0);
    assert.ok(m.history.sysMem.length >= 1);
    assert.deepEqual((await call('list', { kind: 'ops' })).result, []);
    assert.match((await call('list', { kind: 'x' })).error ?? '', /must be one of/);
    assert.deepEqual((await call('backups')).result, []);
    assert.match((await call('versions', { provider: 'nope' })).error ?? '', /Unknown provider/);
    assert.match((await call('install', { provider: 'paper' })).error ?? '', /"version"/);
  });

  it('forwards sample, problems and quitting events', async () => {
    const { core, events, call } = rig();
    await core.metrics.sample();
    assert.equal(events('sample').length, 1);
    core.addProblem({ id: 'p', title: 'T', advice: 'A', fatal: false });
    assert.deepEqual(data(events('problems')[0]), [{ id: 'p', title: 'T', advice: 'A', fatal: false }]);
    assert.equal((await call('shutdown')).result, true);
    await waitFor(() => events('quitting').length === 1, 3000, 'quitting event');
  });
});
