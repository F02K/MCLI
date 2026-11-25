import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { detectServer } from '../src/detect';
import { writeInstallMeta } from '../src/installmeta';
import { listenAddress, velocityBind, VELOCITY_DEFAULT_PORT } from '../src/listen';
import { PlayerTracker } from '../src/players';
import { ServerProcess } from '../src/server';
import { loadConfig } from '../src/config';
import { makeJar, tmp } from './helpers';

describe('Velocity detection', () => {
  it('detects Velocity by manifest or file name, without "nogui"', async () => {
    const a = tmp('velo');
    await makeJar(join(a, 'velocity-3.5.1-40.jar'), { main: 'com.velocitypowered.proxy.Velocity' });
    const found = detectServer(a);
    assert.equal(found?.type, 'velocity');
    assert.equal(found?.mcVersion, '3.5.1');
    assert.deepEqual(found?.launchArgs, ['-jar', 'velocity-3.5.1-40.jar']);

    const b = tmp('velo');
    await makeJar(join(b, 'velocity.jar'), {});
    assert.equal(detectServer(b)?.type, 'velocity');
  });

  it('uses the install metadata and keeps the proxy launch arguments', async () => {
    const dir = tmp('velo');
    await makeJar(join(dir, 'velocity-3.4.0-SNAPSHOT-563.jar'), { main: 'com.velocitypowered.proxy.Velocity' });
    writeInstallMeta(dir, { provider: 'velocity', mcVersion: '3.4.0-SNAPSHOT', identity: '563', file: 'velocity-3.4.0-SNAPSHOT-563.jar', installedAt: 'now' });
    const found = detectServer(dir);
    assert.equal(found?.type, 'velocity');
    assert.deepEqual(found?.launchArgs, ['-jar', 'velocity-3.4.0-SNAPSHOT-563.jar']);
  });

  it('reads the version from a snapshot jar name', async () => {
    const dir = tmp('velo');
    await makeJar(join(dir, 'velocity-3.4.0-SNAPSHOT-563.jar'), {});
    assert.equal(detectServer(dir)?.mcVersion, '3.4.0-SNAPSHOT');
  });
});

describe('listen address', () => {
  it('uses velocity.toml for a proxy, with defaults when it is missing or odd', () => {
    const dir = tmp('listen');
    assert.deepEqual(velocityBind(dir), { host: '0.0.0.0', port: VELOCITY_DEFAULT_PORT });
    writeFileSync(join(dir, 'velocity.toml'), '# config\nbind = "127.0.0.1:25565"\nmotd = "x"\n');
    assert.deepEqual(listenAddress(dir, 'velocity'), { host: '127.0.0.1', port: 25565 });
    writeFileSync(join(dir, 'velocity.toml'), 'motd = "no bind here"\n');
    assert.equal(velocityBind(dir).port, VELOCITY_DEFAULT_PORT);
    writeFileSync(join(dir, 'velocity.toml'), 'bind = "0.0.0.0:abc"\n');
    assert.equal(velocityBind(dir).port, VELOCITY_DEFAULT_PORT);
    writeFileSync(join(dir, 'velocity.toml'), 'bind = "25570"\n');
    assert.equal(velocityBind(dir).port, 25570);
  });

  it('uses server.properties for normal servers', () => {
    const dir = tmp('listen');
    assert.deepEqual(listenAddress(dir, 'paper'), { host: '0.0.0.0', port: 25565 });
    writeFileSync(join(dir, 'server.properties'), 'server-port=25600\nserver-ip=10.0.0.5\n');
    assert.deepEqual(listenAddress(dir, 'paper'), { host: '10.0.0.5', port: 25600 });
  });
});

describe('proxy players', () => {
  it('tracks Velocity connect and disconnect lines', () => {
    const server = new ServerProcess(loadConfig(tmp('velo')));
    const players = new PlayerTracker(server);
    server.emit('line', '[12:00:01 INFO] [connected player] Steve (/203.0.113.7:51234) has connected');
    server.emit('line', '[12:00:02 INFO] [connected player] Alex (/203.0.113.8:51235) has connected');
    assert.deepEqual([...players.online.keys()], ['Steve', 'Alex']);
    server.emit('line', '[12:05:00 INFO] [connected player] Steve (/203.0.113.7:51234) has disconnected');
    assert.deepEqual([...players.online.keys()], ['Alex']);
  });
});
