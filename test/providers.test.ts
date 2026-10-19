import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createProviders, javaForMc, type Endpoints, type Provider } from '../src/providers';
import { json, mockHttp } from './helpers';

const SHA1 = 'a'.repeat(40);
let ep: Endpoints;
let prov: Record<'vanilla' | 'paper' | 'fabric' | 'forge', Provider>;
let closeMock: () => Promise<void> = () => Promise.resolve();
after(() => closeMock());

before(async () => {
  let base = '';
  const mock = await mockHttp((req, res) => {
    const url = req.url ?? '';
    switch (url) {
      case '/mojang/manifest.json':
        return json(res, {
          versions: [
            { id: '26.2', type: 'release', url: `${base}/mojang/26.2.json` },
            { id: '25w01a', type: 'snapshot', url: `${base}/mojang/25w01a.json` },
            { id: '1.21.8', type: 'release', url: `${base}/mojang/1.21.8.json` },
          ],
        });
      case '/mojang/26.2.json':
        return json(res, { javaVersion: { majorVersion: 25 }, downloads: { server: { sha1: SHA1, size: 123, url: 'https://example.invalid/s.jar' } } });
      case '/mojang/1.21.8.json':
        return json(res, { downloads: { server: { sha1: SHA1, size: 456, url: 'https://example.invalid/t.jar' } } });
      case '/mojang/25w01a.json':
        return json(res, {});
      case '/paper':
        return json(res, { versions: { '26.2': ['26.2', '26.2-rc-1'], '1.21': ['1.21.8', '1.21.8-pre1'] } });
      case '/paper/versions/1.21.8/builds':
        return json(res, [
          { id: 58, channel: 'STABLE', downloads: { 'server:default': { name: 'paper-1.21.8-58.jar', url: 'https://example.invalid/58', size: 10, checksums: { sha256: 'b'.repeat(64) } } } },
          { id: 60, channel: 'BETA', downloads: { 'server:default': { name: 'paper-1.21.8-60.jar', url: 'https://example.invalid/60', size: 10, checksums: { sha256: 'c'.repeat(64) } } } },
          { id: 59, channel: 'STABLE', downloads: { 'server:default': { name: 'paper-1.21.8-59.jar', url: 'https://example.invalid/59', size: 10, checksums: { sha256: 'd'.repeat(64) } } } },
        ]);
      case '/paper/versions/26.2/builds':
        return json(res, [{ id: 3, channel: 'ALPHA', downloads: { 'server:default': { name: 'paper-26.2-3.jar', url: 'https://example.invalid/3', size: 10, checksums: { sha256: 'e'.repeat(64) } } } }]);
      case '/paper/versions/1.0/builds':
        return json(res, []);
      case '/paper/versions/1.1/builds':
        return json(res, [{ id: 1, channel: 'STABLE', downloads: {} }]);
      case '/fabric/game':
        return json(res, [{ version: '25w01a', stable: false }, { version: '1.21.8', stable: true }]);
      case '/fabric/loader':
        return json(res, [{ version: '0.20.0', stable: false }, { version: '0.19.5', stable: true }]);
      case '/fabric/installer':
        return json(res, [{ version: '1.1.2', stable: true }]);
      case '/forge/promos.json':
        return json(res, { promos: { '1.20.1-latest': '47.4.10', '1.20.1-recommended': '47.3.0', '1.12.2-latest': '14.23.5.2860', '1.7.10-latest': '10.13.4.1614', '26.2-latest': '60.0.0', '1.20.1-bogus': 'x' } });
      case '/forge/maven/1.20.1-47.3.0/forge-1.20.1-47.3.0-installer.jar.sha1':
        return void res.end(`${SHA1}  forge-installer.jar\n`);
      case '/forge/maven/1.12.2-14.23.5.2860/forge-1.12.2-14.23.5.2860-installer.jar.sha1':
        return void res.end('not a hash');
      default:
        res.writeHead(404);
        res.end('no');
    }
  }, false);
  closeMock = () => mock.close();
  base = mock.base;
  ep = { mojang: `${base}/mojang/manifest.json`, paper: `${base}/paper`, fabric: `${base}/fabric`, forgePromos: `${base}/forge/promos.json`, forgeMaven: `${base}/forge/maven` };
  prov = createProviders(ep);
});

describe('javaForMc', () => {
  it('maps classic versions to the Java Minecraft needs', () => {
    assert.equal(javaForMc('1.8.9'), 8);
    assert.equal(javaForMc('1.16.5'), 8);
    assert.equal(javaForMc('1.17.1'), 16);
    assert.equal(javaForMc('1.18'), 17);
    assert.equal(javaForMc('1.20.4'), 17);
    assert.equal(javaForMc('1.20.5'), 21);
    assert.equal(javaForMc('1.21.8'), 21);
    assert.equal(javaForMc('26.2'), undefined);
  });
});

describe('vanilla provider', () => {
  it('lists releases (and snapshots on request)', async () => {
    assert.deepEqual(await prov.vanilla.versions(false), ['26.2', '1.21.8']);
    assert.deepEqual(await prov.vanilla.versions(true), ['26.2', '25w01a', '1.21.8']);
  });
  it('plans a download with sha1, size and Java version', async () => {
    const plan = await prov.vanilla.plan('26.2');
    assert.equal(plan.filename, 'minecraft_server.26.2.jar');
    assert.equal(plan.sha1, SHA1);
    assert.equal(plan.size, 123);
    assert.equal(plan.javaMajor, 25);
    assert.equal(plan.kind, 'jar');
    assert.equal((await prov.vanilla.plan('1.21.8')).javaMajor, 21, 'falls back to the mapping');
  });
  it('rejects unknown versions and versions without a server download', async () => {
    await assert.rejects(prov.vanilla.plan('0.0'), /does not exist/);
    await assert.rejects(prov.vanilla.plan('25w01a'), /no server download/);
  });
});

describe('paper provider', () => {
  it('lists stable versions, newest first, and pre-releases on request', async () => {
    assert.deepEqual(await prov.paper.versions(false), ['26.2', '1.21.8']);
    assert.deepEqual(await prov.paper.versions(true), ['26.2', '26.2-rc-1', '1.21.8', '1.21.8-pre1']);
  });
  it('picks the newest STABLE build and carries the SHA-256', async () => {
    const plan = await prov.paper.plan('1.21.8');
    assert.equal(plan.identity, '59');
    assert.equal(plan.filename, 'paper-1.21.8-59.jar');
    assert.equal(plan.sha256, 'd'.repeat(64));
    assert.equal(plan.channel, 'STABLE');
    assert.equal(plan.display, 'Paper 1.21.8 build 59');
  });
  it('falls back to the newest build and labels non-stable channels', async () => {
    const plan = await prov.paper.plan('26.2');
    assert.equal(plan.identity, '3');
    assert.match(plan.display, /ALPHA/);
    assert.equal(plan.javaMajor, 25, 'asks Mojang for versions the mapping does not know');
  });
  it('fails for versions without builds or download', async () => {
    await assert.rejects(prov.paper.plan('1.0'), /no builds/);
    await assert.rejects(prov.paper.plan('1.1'), /no server download/);
  });
});

describe('fabric provider', () => {
  it('lists stable game versions only by default', async () => {
    assert.deepEqual(await prov.fabric.versions(false), ['1.21.8']);
    assert.deepEqual(await prov.fabric.versions(true), ['25w01a', '1.21.8']);
  });
  it('combines the latest stable loader and installer into one download', async () => {
    const plan = await prov.fabric.plan('1.21.8');
    assert.equal(plan.identity, '0.19.5/1.1.2');
    assert.equal(plan.filename, 'fabric-server-mc.1.21.8-loader.0.19.5-launcher.1.1.2.jar');
    assert.ok(plan.url.endsWith('/loader/1.21.8/0.19.5/1.1.2/server/jar'));
    assert.equal(plan.sha256, undefined);
  });
});

describe('forge provider', () => {
  it('lists Minecraft versions from 1.12.2 up, newest first', async () => {
    assert.deepEqual(await prov.forge.versions(false), ['26.2', '1.20.1', '1.12.2']);
  });
  it('prefers the recommended build and reads the published SHA-1', async () => {
    const plan = await prov.forge.plan('1.20.1');
    assert.equal(plan.identity, '47.3.0');
    assert.equal(plan.kind, 'forge-installer');
    assert.equal(plan.filename, 'forge-1.20.1-47.3.0-installer.jar');
    assert.equal(plan.sha1, SHA1);
    assert.equal(plan.javaMajor, 17);
  });
  it('uses the latest build when nothing is recommended and ignores bad checksums', async () => {
    const plan = await prov.forge.plan('1.12.2');
    assert.equal(plan.identity, '14.23.5.2860');
    assert.equal(plan.sha1, undefined);
    assert.equal(plan.javaMajor, 8);
  });
  it('fails when Forge has no build for the version', async () => {
    await assert.rejects(prov.forge.plan('1.2.3'), /no build/);
  });
});
