import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { detectServer, readManifest } from '../src/detect';
import { writeInstallMeta } from '../src/installmeta';
import { makeJar, tmp } from './helpers';

const win = process.platform === 'win32';
const argsFile = win ? 'win_args.txt' : 'unix_args.txt';

async function folder(jars: Record<string, string | undefined>): Promise<string> {
  const dir = tmp('detect');
  for (const [name, main] of Object.entries(jars)) await makeJar(join(dir, name), { main });
  return dir;
}

describe('detectServer', () => {
  it('returns null for empty or missing folders', () => {
    assert.equal(detectServer(tmp('detect')), null);
    assert.equal(detectServer(join(tmp('detect'), 'missing')), null);
  });

  it('detects vanilla by manifest and by file name', async () => {
    const byManifest = detectServer(await folder({ 'whatever.jar': 'net.minecraft.bundler.Main' }));
    assert.equal(byManifest?.type, 'vanilla');
    assert.deepEqual(byManifest?.launchArgs, ['-jar', 'whatever.jar', 'nogui']);
    const byName = detectServer(await folder({ 'minecraft_server.1.20.4.jar': undefined }));
    assert.equal(byName?.type, 'vanilla');
    assert.equal(byName?.mcVersion, '1.20.4');
    assert.equal(detectServer(await folder({ 'server.jar': undefined }))?.type, 'vanilla');
  });

  it('detects paper (manifest or name) and its version', async () => {
    const a = detectServer(await folder({ 'paper-1.21.8-60.jar': 'io.papermc.paperclip.Main' }));
    assert.equal(a?.type, 'paper');
    assert.equal(a?.mcVersion, '1.21.8');
    assert.equal(detectServer(await folder({ 'paper.jar': undefined }))?.type, 'paper');
  });

  it('detects fabric', async () => {
    const a = detectServer(await folder({ 'fabric-server-mc.1.21.8-loader.0.17.2-launcher.1.1.0.jar': 'net.fabricmc.installer.ServerLauncher' }));
    assert.equal(a?.type, 'fabric');
    assert.equal(a?.mcVersion, '1.21.8');
    assert.equal(detectServer(await folder({ 'fabric-server-launch.jar': undefined }))?.type, 'fabric');
  });

  it('detects old Forge by jar name', async () => {
    const d = detectServer(await folder({ 'forge-1.12.2-14.23.5.2860.jar': 'net.minecraft.launchwrapper.Launch' }));
    assert.equal(d?.type, 'forge');
    assert.equal(d?.mcVersion, '1.12.2');
    assert.equal(d?.jar, 'forge-1.12.2-14.23.5.2860.jar');
  });

  it('detects modern Forge and NeoForge from their args files', () => {
    const dir = tmp('detect');
    const lib = join(dir, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.2.0');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, argsFile), '');
    let d = detectServer(dir);
    assert.equal(d?.type, 'forge');
    assert.equal(d?.mcVersion, '1.20.1');
    assert.deepEqual(d?.launchArgs, [`@libraries/net/minecraftforge/forge/1.20.1-47.2.0/${argsFile}`, 'nogui']);
    writeFileSync(join(dir, 'user_jvm_args.txt'), '-Xmx2G');
    d = detectServer(dir);
    assert.equal(d?.launchArgs[0], '@user_jvm_args.txt');

    const neo = tmp('detect');
    const nlib = join(neo, 'libraries', 'net', 'neoforged', 'neoforge', '21.1.50');
    mkdirSync(nlib, { recursive: true });
    writeFileSync(join(nlib, argsFile), '');
    assert.equal(detectServer(neo)?.type, 'neoforge');
  });

  it('prefers the newest jar when several server jars are present', async () => {
    const dir = await folder({ 'paper-1.20.1-1.jar': 'io.papermc.paperclip.Main', 'paper-1.21.8-60.jar': 'io.papermc.paperclip.Main' });
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(join(dir, 'paper-1.20.1-1.jar'), old, old);
    assert.equal(detectServer(dir)?.jar, 'paper-1.21.8-60.jar');
  });

  it('ignores installers and non-jar files', async () => {
    const dir = await folder({ 'forge-1.12.2-14.23.5.2860-installer.jar': 'x.Installer' });
    writeFileSync(join(dir, 'notes.txt'), 'x');
    assert.equal(detectServer(dir), null);
  });

  it('trusts the install metadata over leftovers', async () => {
    const dir = await folder({ 'paper-1.21.8-60.jar': 'io.papermc.paperclip.Main', 'minecraft_server.1.21.8.jar': 'net.minecraft.bundler.Main' });
    writeInstallMeta(dir, { provider: 'vanilla', mcVersion: '1.21.8', identity: '1.21.8', file: 'minecraft_server.1.21.8.jar', installedAt: 'x' });
    const d = detectServer(dir);
    assert.equal(d?.type, 'vanilla');
    assert.equal(d?.jar, 'minecraft_server.1.21.8.jar');
  });

  it('falls back to scanning when the metadata file points to a missing jar', async () => {
    const dir = await folder({ 'paper-1.21.8-60.jar': 'io.papermc.paperclip.Main' });
    writeInstallMeta(dir, { provider: 'vanilla', mcVersion: '1.21.8', identity: 'x', file: 'gone.jar', installedAt: 'x' });
    assert.equal(detectServer(dir)?.type, 'paper');
  });

  it('metadata for forge uses the args launcher', () => {
    const dir = tmp('detect');
    const lib = join(dir, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.2.0');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, argsFile), '');
    writeInstallMeta(dir, { provider: 'forge', mcVersion: '1.20.1', identity: '47.2.0', file: 'installer.jar', installedAt: 'x' });
    assert.equal(detectServer(dir)?.type, 'forge');
  });
});

describe('readManifest', () => {
  it('parses attributes including wrapped lines', async () => {
    const dir = tmp('detect');
    const jar = join(dir, 'a.jar');
    await makeJar(jar, { main: 'a.b.Main' });
    assert.equal(readManifest(jar)?.['Main-Class'], 'a.b.Main');
  });
  it('returns null for broken or missing jars', () => {
    const dir = tmp('detect');
    writeFileSync(join(dir, 'x.jar'), 'junk');
    assert.equal(readManifest(join(dir, 'x.jar')), null);
    assert.equal(readManifest(join(dir, 'missing.jar')), null);
  });
});
