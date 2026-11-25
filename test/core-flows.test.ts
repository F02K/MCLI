import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Core } from '../src/core';
import { addFakeJava, fakeJavaVerify, makeCore, providerWorld, tmp, waitFor, type ProviderWorld } from './helpers';

const infos = (core: Core): string => core.logs.filter((l) => l.src === 'mcli').map((l) => l.text).join('\n');

async function rig(cfg: Record<string, unknown> = {}) {
  const world = await providerWorld();
  const dir = tmp('flows');
  const core = makeCore(dir, cfg, { endpoints: world.endpoints, javaApi: world.javaApi, javaVerify: fakeJavaVerify });
  return { world, dir, core };
}

async function withPaper(world: ProviderWorld, core: Core): Promise<void> {
  assert.equal(await core.installVersion('paper', '1.21.8', false), true, infos(core));
}

describe('versions and installing', () => {
  it(':versions lists versions from the provider and reports API failures', async () => {
    const { core } = await rig();
    core.exec(':versions paper');
    await waitFor(() => /Paper: 2 versions/.test(infos(core)));
    assert.match(infos(core), /1\.21\.8, 1\.20\.4/);
    const broken = makeCore(tmp('flows'), {}, { endpoints: { ...core.cfg, mojang: 'http://127.0.0.1:1/x', paper: 'http://127.0.0.1:1/x', velocity: 'http://127.0.0.1:1/x', fabric: 'http://127.0.0.1:1/x', forgePromos: 'http://127.0.0.1:1/x', forgeMaven: 'http://127.0.0.1:1/x' } });
    broken.exec(':versions vanilla');
    await waitFor(() => /Could not load versions/.test(infos(broken)));
  });

  it('installs a Paper build end to end and tracks it', async () => {
    const { world, dir, core } = await rig();
    await withPaper(world, core);
    assert.ok(existsSync(join(dir, 'paper-1.21.8-59.jar')));
    const inst = core.installed();
    assert.deepEqual([inst.provider, inst.mcVersion, inst.identity, inst.javaMajor], ['paper', '1.21.8', '59', 21]);
    assert.equal(core.describeServer(), 'paper 1.21.8');
    assert.match(infos(core), /Installed Paper 1\.21\.8 build 59/);
  });

  it(':install works from the console, and unknown versions fail cleanly', async () => {
    const { dir, core } = await rig();
    core.exec(':install vanilla 1.20.4');
    await waitFor(() => existsSync(join(dir, 'minecraft_server.1.20.4.jar')), 8000, 'vanilla install');
    assert.equal(await core.installVersion('vanilla', '9.9.9', false), false);
    assert.match(infos(core), /does not exist/);
    core.exec(':install nonsense 1.0');
    assert.match(infos(core), /Usage: :install/);
  });

  it('installs Fabric from the combined loader/installer download', async () => {
    const { dir, core } = await rig();
    assert.equal(await core.installVersion('fabric', '1.21.8', false), true, infos(core));
    assert.ok(existsSync(join(dir, 'fabric-server-mc.1.21.8-loader.0.19.5-launcher.1.1.2.jar')));
    assert.equal(core.installed().provider, 'fabric');
  });

  it('refuses the Forge installer when no Java fits, with a clear message', async () => {
    const { core } = await rig();
    // the mock serves no forge installer; the Java check comes first anyway
    assert.equal(await core.installVersion('forge', '1.20.1', false), false);
    assert.match(infos(core), /Cannot run the Forge installer|Install failed/);
    assert.ok(core.problems.some((p) => p.id === 'java-install' && p.javaMajor === 17));
  });
});

describe('updates', () => {
  it('detects a newer build of the same Minecraft version and updates to it', async () => {
    const { world, dir, core } = await rig();
    await withPaper(world, core);
    let info = await core.checkUpdates(); // joins the check that the install started
    assert.equal(info.sameMc, undefined);
    assert.equal(info.newerMc, undefined);

    world.setPaperBuild(62);
    info = await core.checkUpdates();
    assert.equal(info.sameMc?.identity, '62');
    assert.match(infos(core), /Update available: Paper 1\.21\.8 build 62/);

    assert.equal(await core.update(), true);
    assert.ok(existsSync(join(dir, 'paper-1.21.8-62.jar')));
    assert.equal(core.installed().identity, '62');
    assert.equal(core.updateInfo?.sameMc, undefined);
  });

  it('offers the newest Minecraft version and installs it with "update latest"', async () => {
    const { dir, core } = await rig();
    assert.equal(await core.installVersion('paper', '1.20.4', false), true, infos(core));
    const info = await core.checkUpdates();
    assert.equal(info.newerMc, '1.21.8');
    assert.equal(await core.update(), true);
    assert.match(infos(core), /Already on the newest build of 1\.20\.4\. Use ":update latest" for Minecraft 1\.21\.8/);
    core.exec(':update latest');
    await waitFor(() => existsSync(join(dir, 'paper-1.21.8-59.jar')), 8000, 'upgrade');
  });

  it('says "up to date" and handles servers MCLI did not install', async () => {
    const { world, core } = await rig();
    await withPaper(world, core);
    await core.update();
    assert.match(infos(core), /Already up to date/);

    const stranger = tmp('flows');
    writeFileSync(join(stranger, 'whatever.jar'), 'x');
    const other = makeCore(stranger, {}, { endpoints: world.endpoints });
    const info = await other.checkUpdates();
    assert.equal(info.unknown, true);
    assert.equal(await other.update(), false);
    assert.match(infos(other), /not tracked by MCLI/);
  });

  it('survives an unreachable update server', async () => {
    const { world, dir, core } = await rig();
    await withPaper(world, core);
    const offline = makeCore(dir, {}, { endpoints: { ...world.endpoints, paper: 'http://127.0.0.1:1/paper' } });
    const info = await offline.checkUpdates();
    assert.ok(info.error);
    assert.equal(await offline.update(), false);
    assert.match(infos(offline), /Update check failed/);
  });
});

describe('verify and repair', () => {
  it('confirms an intact jar, including the checksum from the download', async () => {
    const { world, core } = await rig();
    await withPaper(world, core);
    const r = await core.verify();
    assert.equal(r?.check.ok, true);
    assert.equal(r?.hashOk, true);
    assert.equal(core.lastVerify, r);
    assert.match(infos(core), /is intact/);
    assert.equal(core.verifying, false);
  });

  it('flags a modified jar as a problem and repair downloads it again', async () => {
    const { world, dir, core } = await rig();
    await withPaper(world, core);
    const jar = join(dir, 'paper-1.21.8-59.jar');
    const bytes = readFileSync(jar);
    bytes[5] ^= 0xff; // damage inside the first entry
    bytes[bytes.length - 40] ^= 0xff;
    writeFileSync(jar, bytes);
    const bad = await core.verify();
    assert.equal(bad?.check.ok, false);
    assert.ok(core.problems.some((p) => p.id === 'jar-broken'));

    assert.equal(await core.repair(), true);
    assert.equal(core.problems.some((p) => p.id === 'jar-broken'), false);
    assert.equal((await core.verify())?.check.ok, true);
  });

  it('notices a jar that is intact but not what MCLI downloaded', async () => {
    const { world, dir, core } = await rig();
    await withPaper(world, core);
    // replace by another valid jar with different content
    const other = await rig();
    await withPaper(other.world, other.core);
    writeFileSync(join(dir, 'paper-1.21.8-59.jar'), readFileSync(join(other.dir, 'paper-1.21.8-59.jar')));
    const r = await core.verify();
    assert.equal(r?.hashOk, false);
    assert.match(r?.check.problems.join(' ') ?? '', /differs from what MCLI downloaded/);
  });

  it('has nothing to verify without a launch jar, and cannot repair an unknown install', async () => {
    const { core } = await rig();
    assert.equal(await core.verify(), null);
    assert.match(infos(core), /Nothing to verify/);
    assert.equal(await core.repair(), false);
    assert.match(infos(core), /Cannot repair/);
  });

  it('works through the console commands', async () => {
    const { world, core } = await rig();
    await withPaper(world, core);
    core.exec(':verify');
    await waitFor(() => /is intact/.test(infos(core)));
    core.exec(':repair');
    await waitFor(() => (infos(core).match(/Installed Paper/g) ?? []).length === 2, 8000, 'repair');
  });
});

describe('java commands', () => {
  it(':java lists installs, installs a version and switches between fixed and automatic', async () => {
    const { dir, core } = await rig();
    addFakeJava(dir, 17);
    core.exec(':java');
    await waitFor(() => /Active: chosen automatically/.test(infos(core)));
    assert.match(infos(core), /Java 17\s+Temurin\s+JRE \[MCLI\]/);

    core.exec(':java install 99');
    await waitFor(() => /Java 99 is ready/.test(infos(core)), 8000, 'java install');
    core.exec(':java install abc');
    assert.match(infos(core), /Usage: :java install/);
    core.exec(':java install 98');
    await waitFor(() => /Java 98 could not be installed/.test(infos(core)));

    core.exec(':java use C:/some/where/java.exe');
    await waitFor(() => core.cfg.java === 'C:/some/where/java.exe');
    assert.equal((JSON.parse(readFileSync(join(dir, 'mcli.json'), 'utf8')) as { java: string }).java, 'C:/some/where/java.exe');
    core.exec(':java use auto');
    await waitFor(() => core.cfg.java === '');
    core.exec(':java use');
    assert.match(infos(core), /Usage: :java use/);
    core.exec(':java');
    await waitFor(() => /Active:/.test(infos(core)));
    assert.equal(core.currentJava().length > 0, true);
  });

  it(':java reports when nothing is installed', async () => {
    const { core } = await rig();
    core.exec(':java');
    await waitFor(() => /No Java installation found/.test(infos(core)));
  });
});
