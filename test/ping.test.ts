import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { after, describe, it } from 'node:test';
import { pingServer } from '../src/ping';

function varint(n: number): Buffer {
  const bytes: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    bytes.push(b);
  } while (n);
  return Buffer.from(bytes);
}

function statusPacket(payload: unknown, id = 0): Buffer {
  const json = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const body = Buffer.concat([varint(id), varint(json.length), json]);
  return Buffer.concat([varint(body.length), body]);
}

async function fakeServer(onRequest: (socket: Socket) => void): Promise<number> {
  const srv = createServer((s) => {
    s.on('error', () => {});
    s.once('data', () => onRequest(s));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  after(() => srv.close());
  return (srv.address() as AddressInfo).port;
}

const status = {
  version: { name: 'Paper 1.21.8', protocol: 772 },
  players: { max: 20, online: 3 },
  description: { text: '§aHello ', extra: [{ text: 'World' }] },
};

describe('pingServer', () => {
  it('reads version, players and a flattened MOTD', async () => {
    const port = await fakeServer((s) => s.write(statusPacket(status)));
    const r = await pingServer('127.0.0.1', port);
    assert.equal(r.version, 'Paper 1.21.8');
    assert.equal(r.protocol, 772);
    assert.equal(r.online, 3);
    assert.equal(r.max, 20);
    assert.equal(r.motd, 'Hello World');
    assert.ok(r.latencyMs >= 0);
  });

  it('reassembles a response that arrives in pieces', async () => {
    const pkt = statusPacket({ ...status, description: 'plain motd' });
    const port = await fakeServer((s) => {
      s.write(pkt.subarray(0, 3));
      setTimeout(() => s.write(pkt.subarray(3, 20)), 20);
      setTimeout(() => s.write(pkt.subarray(20)), 40);
    });
    assert.equal((await pingServer('127.0.0.1', port)).motd, 'plain motd');
  });

  it('copes with missing optional fields', async () => {
    const port = await fakeServer((s) => s.write(statusPacket({})));
    const r = await pingServer('127.0.0.1', port);
    assert.equal(r.version, '?');
    assert.equal(r.max, 0);
    assert.equal(r.motd, '');
  });

  it('rejects when nothing listens', async () => {
    const port = await fakeServer(() => {});
    // a port that is certainly closed: reuse then close
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    await assert.rejects(pingServer('127.0.0.1', deadPort, 500));
    assert.ok(port > 0);
  });

  it('times out on a silent server', async () => {
    const port = await fakeServer(() => {});
    await assert.rejects(pingServer('127.0.0.1', port, 200), /timeout/);
  });

  it('rejects garbage and unexpected packets', async () => {
    const bad = await fakeServer((s) => s.write(statusPacket('{not json')));
    await assert.rejects(pingServer('127.0.0.1', bad));
    const wrongId = await fakeServer((s) => s.write(statusPacket(status, 7)));
    await assert.rejects(pingServer('127.0.0.1', wrongId), /unexpected packet/);
  });

  it('rejects when the server closes the connection without answering', async () => {
    const port = await fakeServer((s) => s.end());
    await assert.rejects(pingServer('127.0.0.1', port), /closed/);
  });
});
