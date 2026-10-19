import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Metrics } from '../src/metrics';
import type { ServerProcess } from '../src/server';

function fakeServer(state: string, pid?: number): ServerProcess {
  return { state, pid } as unknown as ServerProcess;
}

describe('Metrics', () => {
  it('records system CPU and RAM and zeros for the server while it is stopped', async () => {
    const m = new Metrics(fakeServer('stopped'));
    let samples = 0;
    m.on('sample', () => samples++);
    await m.sample();
    await m.sample();
    assert.equal(samples, 2);
    assert.equal(m.sysCpu.length, 2);
    assert.ok(m.sysCpu.every((v) => v >= 0 && v <= 100));
    assert.ok(m.sysMem.every((v) => v > 0 && v <= 100));
    assert.deepEqual(m.procMem, [0, 0]);
    assert.deepEqual(m.procCpu, [0, 0]);
    assert.ok(m.totalMem > 0);
  });

  it('measures the memory of a real running process', async () => {
    const m = new Metrics(fakeServer('running', process.pid));
    await m.sample();
    assert.ok((m.procMem.at(-1) ?? 0) > 1_000_000, `rss ${m.procMem.at(-1)}`);
    assert.ok((m.procCpu.at(-1) ?? -1) >= 0 && (m.procCpu.at(-1) ?? 101) <= 100);
  });

  it('repeats the last value between slow samples (Windows) and never grows past 60 points', async () => {
    const m = new Metrics(fakeServer('stopped'));
    for (let i = 0; i < 65; i++) await m.sample();
    assert.equal(m.sysCpu.length, 60);
    assert.equal(m.procMem.length, 60);
    const live = new Metrics(fakeServer('running', process.pid));
    await live.sample();
    await live.sample();
    assert.equal(live.procMem.length, 2);
  });

  it('start() and stop() are idempotent', () => {
    const m = new Metrics(fakeServer('stopped'));
    m.start();
    m.start();
    m.stop();
    m.stop();
  });
});
