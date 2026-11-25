import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { detectServer } from '../src/detect';
import { inspectFolder } from '../src/inspect';
import { makeJar, tmp } from './helpers';

const file = (dir: string, rel: string, text = 'x') => {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

async function paperFolder(extra: Record<string, string> = {}): Promise<string> {
  const dir = tmp('inspect');
  await makeJar(join(dir, 'paper-1.21.8-60.jar'), { main: 'io.papermc.paperclip.Main' });
  file(dir, 'server.properties', '#Minecraft server properties\nserver-port=25570\nserver-ip=\nonline-mode=true\nmotd=My Server\nlevel-name=survival\n');
  file(dir, 'eula.txt', 'eula=true\n');
  file(dir, 'survival/level.dat');
  file(dir, 'survival_nether/level.dat');
  file(dir, 'plugins/EssentialsX.jar');
  file(dir, 'plugins/Vault.jar');
  file(dir, 'plugins/notes.txt');
  file(dir, 'config/paper-global.yml');
  for (const [name, text] of Object.entries(extra)) file(dir, name, text);
  return dir;
}

describe('inspectFolder', () => {
  it('reports a folder that does not exist or is a file', async () => {
    const dir = tmp('inspect');
    const missing = await inspectFolder(join(dir, 'nope'));
    assert.equal(missing.exists, false);
    assert.match(missing.warnings[0], /does not exist/);
    file(dir, 'a.txt');
    const f = await inspectFolder(join(dir, 'a.txt'));
    assert.equal(f.isDirectory, false);
    assert.match(f.warnings[0], /not a folder/);
  });

  it('says so when there is no server in the folder', async () => {
    const r = await inspectFolder(tmp('inspect'));
    assert.equal(r.software, null);
    assert.equal(r.isDirectory, true);
    assert.match(r.warnings[0], /No Minecraft server/);
    assert.equal(r.eula, 'missing');
    assert.deepEqual(r.worlds, []);
  });

  it('describes an existing Paper server', async () => {
    const dir = await paperFolder();
    const r = await inspectFolder(dir);
    assert.deepEqual(r.software, { type: 'paper', version: '1.21.8', jar: 'paper-1.21.8-60.jar' });
    assert.equal(r.eula, 'accepted');
    assert.deepEqual(r.properties, { port: 25570, ip: '', onlineMode: true, motd: 'My Server', levelName: 'survival' });
    assert.deepEqual(r.worlds, ['survival', 'survival_nether']);
    assert.deepEqual(r.plugins, ['EssentialsX.jar', 'Vault.jar']);
    assert.equal(r.files.paperGlobal, true);
    assert.equal(r.files.velocityToml, false);
    assert.equal(r.managedByMcli, false);
    assert.ok(r.sizeBytes > 30_000, 'the size counts the jar');
    assert.deepEqual(r.warnings, []);
    assert.ok(r.javaMajor === null || r.javaMajor >= 17);
  });

  it('finds the Minecraft version when the jar name does not say', async () => {
    const byHistory = tmp('inspect');
    await makeJar(join(byHistory, 'paper.jar'), { main: 'io.papermc.paperclip.Main' });
    file(byHistory, 'version_history.json', '{"currentVersion": "1.21.4-222-abcdef (MC: 1.21.4)"}');
    assert.equal((await inspectFolder(byHistory)).software?.version, '1.21.4');
    const byLog = tmp('inspect');
    await makeJar(join(byLog, 'server.jar'), { main: 'io.papermc.paperclip.Main' });
    file(byLog, 'logs/latest.log', '[10:00:00] [Server thread/INFO]: Starting minecraft server version 1.20.6\n');
    assert.equal((await inspectFolder(byLog)).software?.version, '1.20.6');
    const unknown = tmp('inspect');
    await makeJar(join(unknown, 'paper.jar'), { main: 'io.papermc.paperclip.Main' });
    assert.equal((await inspectFolder(unknown)).software?.version, null);
  });

  it('recognises Spigot and warns that it needs to become Paper', async () => {
    const dir = tmp('inspect');
    await makeJar(join(dir, 'spigot-1.20.4.jar'), { main: 'org.bukkit.craftbukkit.bootstrap.Main' });
    assert.equal(detectServer(dir)?.type, 'spigot');
    const r = await inspectFolder(dir);
    assert.deepEqual(r.software, { type: 'spigot', version: '1.20.4', jar: 'spigot-1.20.4.jar' });
    assert.ok(r.warnings.some((w) => /switch it to Paper/.test(w)));
  });

  it('warns about servers that cannot sit behind the proxy', async () => {
    const dir = tmp('inspect');
    await makeJar(join(dir, 'fabric-server-mc.1.21.8-loader.0.17.0-launcher.1.0.1.jar'), { main: 'net.fabricmc.loader.impl.launch.server.FabricServerLauncher' });
    file(dir, 'mods/a.jar');
    file(dir, 'server.properties', 'online-mode=false\n');
    const r = await inspectFolder(dir);
    assert.equal(r.software?.type, 'fabric');
    assert.equal(r.mods, 1);
    assert.ok(r.warnings.some((w) => /without extra mods/.test(w)));
    assert.ok(r.warnings.some((w) => /offline mode/.test(w)));
  });

  it('warns about the mods folder on Paper and about declined EULA', async () => {
    const dir = await paperFolder({ 'mods/x.jar': 'x', 'eula.txt': 'eula=false\n' });
    const r = await inspectFolder(dir);
    assert.ok(r.warnings.some((w) => /mods folder is ignored/.test(w)));
    assert.equal(r.eula, 'declined');
  });

  it('knows an existing Velocity proxy and what it already has', async () => {
    const dir = tmp('inspect');
    await makeJar(join(dir, 'velocity-3.5.1-615.jar'), { main: 'com.velocitypowered.proxy.Velocity' });
    file(dir, 'velocity.toml', 'bind = "0.0.0.0:25565"\n');
    file(dir, 'forwarding.secret', 's');
    const r = await inspectFolder(dir);
    assert.deepEqual(r.software, { type: 'velocity', version: '3.5.1', jar: 'velocity-3.5.1-615.jar' });
    assert.deepEqual(r.files, { velocityToml: true, paperGlobal: false, forwardingSecret: true });
    assert.equal(r.javaMajor, 17);
    assert.deepEqual(r.warnings, []);
  });

  it('notices folders MCLI installed', async () => {
    const dir = await paperFolder({ 'mcli-install.json': JSON.stringify({ provider: 'paper', mcVersion: '1.21.8', identity: '60', file: 'paper-1.21.8-60.jar', javaMajor: 21, installedAt: 'now' }) });
    const r = await inspectFolder(dir);
    assert.equal(r.managedByMcli, true);
    assert.equal(r.javaMajor, 21);
  });
});
