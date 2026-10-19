import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { folderOpener } from '../src/tui/views/backups';
import { addFakeJava, customLaunch, fakeJavaVerify, K, providerWorld, tmp, tuiRig, waitFor, type ProviderWorld, type Rig } from './helpers';

async function versionsRig(opts: { world?: ProviderWorld; cfg?: Record<string, unknown>; worlds?: boolean } = {}): Promise<{ rig: Rig; dir: string; world: ProviderWorld }> {
  const world = opts.world ?? (await providerWorld());
  const dir = tmp('tui');
  if (opts.worlds) {
    mkdirSync(join(dir, 'world'));
    writeFileSync(join(dir, 'world', 'level.dat'), 'x');
  }
  const rig = await tuiRig(dir, opts.cfg ?? {}, { endpoints: world.endpoints, javaApi: world.javaApi, javaVerify: fakeJavaVerify });
  await rig.press(K.f(5));
  return { rig, dir, world };
}

const screenHas = (rig: Rig, re: RegExp, ms = 5000) => waitFor(() => re.test(rig.screen()), ms, String(re));

describe('Versions view', () => {
  it('shows an empty install, then installs Paper through the menus', async () => {
    const { rig, dir } = await versionsRig();
    assert.match(rig.screen(), /nothing installed - press I to install one/);
    await rig.press('i');
    assert.match(rig.screen(), /Install server software/);
    assert.match(rig.screen(), /Paper\s+fast, plugins \(recommended\)/);
    assert.match(rig.screen(), /Vanilla \(Mojang\)/);
    await rig.press(K.enter); // Paper
    await screenHas(rig, /choose a Minecraft version/);
    assert.match(rig.screen(), /« include snapshots \/ pre-releases/);
    assert.match(rig.screen(), /1\.21\.8\s+newest/);
    await rig.press(K.enter); // preselected newest
    await screenHas(rig, /Paper 1\.21\.8 build 59/);
    assert.match(rig.screen(), /File\s+paper-1\.21\.8-59\.jar/);
    assert.match(rig.screen(), /Checksum SHA-256/);
    assert.match(rig.screen(), /│ Install\s+│/);
    await rig.press(K.enter); // "Install" (no world => no backup choice)
    await waitFor(() => existsSync(join(dir, 'paper-1.21.8-59.jar')), 8000, 'jar installed');
    await screenHas(rig, /Installed Paper 1\.21\.8 build 59/);
    await rig.refresh();
    assert.match(rig.screen(), /Server\s+paper 1\.21\.8/);
    assert.match(rig.screen(), /Build\s+59/);
    assert.match(rig.screen(), /✓ structure ok/);
    await screenHas(rig, /Updates\s+✓ newest build/); // the update check runs in the background
  });

  it('offers a backup first when a world exists, and installs after "Back up the world, then install"', async () => {
    const { rig, dir } = await versionsRig({ worlds: true });
    await rig.press('i', K.down, K.enter); // Vanilla
    await screenHas(rig, /Vanilla \(Mojang\) - choose a Minecraft version/);
    await rig.press(K.down, K.enter); // second entry is 1.20.4
    await screenHas(rig, /Vanilla 1\.20\.4/);
    assert.match(rig.screen(), /Back up the world, then install/);
    assert.match(rig.screen(), /Install without a backup/);
    await rig.press(K.enter);
    await waitFor(() => existsSync(join(dir, 'minecraft_server.1.20.4.jar')), 8000, 'vanilla install');
    assert.equal((await rig.core.backups.list()).length, 1, 'a backup was made first');
  });

  it('can include snapshots and cancel at every step', async () => {
    const { rig } = await versionsRig();
    await rig.press('i', K.enter);
    await screenHas(rig, /choose a Minecraft version/);
    await rig.press(K.up, K.enter); // toggle -> reloads with snapshots
    await screenHas(rig, /« hide snapshots/);
    await rig.press(K.esc);
    await rig.press('i', K.esc);
    await rig.press('i', K.enter, K.esc);
    await screenHas(rig, /Installed server/);
  });

  it('warns about downgrades', async () => {
    const { rig, world } = await versionsRig();
    assert.equal(await rig.core.installVersion('paper', '1.21.8', false), true);
    await rig.refresh();
    await rig.press('i', K.enter);
    await screenHas(rig, /choose a Minecraft version/);
    await rig.press(K.down, K.enter); // 1.20.4 < installed 1.21.8
    await screenHas(rig, /Paper 1\.20\.4 build 7/);
    assert.match(rig.screen(), /1\.20\.4 is OLDER than 1\.21\.8/);
    await rig.press(K.esc);
    assert.ok(world);
  });

  it('refuses to install while the server runs or another job is busy', async () => {
    const dir = tmp('tui');
    const world = await providerWorld();
    const rig = await tuiRig(dir, customLaunch(dir), { endpoints: world.endpoints, javaVerify: fakeJavaVerify });
    await rig.press('s');
    await waitFor(() => rig.core.server.state === 'running');
    await rig.press(K.f(5), 'i');
    assert.match(rig.screen(), /Stop the server first/);
    await rig.press('u');
    await screenHas(rig, /Stop the server first/);
    await rig.press('r');
    assert.match(rig.screen(), /Stop the server first/);
    await rig.press(K.f(1), 'x');
    await waitFor(() => rig.core.server.state === 'stopped');
    rig.core.installer.busy = 'Downloading something';
    await rig.press(K.f(5), 'i');
    assert.match(rig.screen(), /Busy: Downloading something/);
    rig.core.installer.busy = null;
  });

  it('updates to a newer build and upgrades to a newer Minecraft version', async () => {
    const { rig, dir, world } = await versionsRig();
    assert.equal(await rig.core.installVersion('paper', '1.20.4', false), true);
    await rig.core.checkUpdates();
    world.setPaperBuild(62);
    await rig.core.checkUpdates();
    await rig.press('u');
    await screenHas(rig, /Upgrade to Minecraft 1\.21\.8/);
    assert.match(rig.screen(), /Installed: paper 1\.20\.4 \(7\)/);
    await rig.press(K.enter); // first entry: upgrade to the newest Minecraft version
    await screenHas(rig, /Paper 1\.21\.8 build 62/);
    await rig.press(K.enter);
    await waitFor(() => existsSync(join(dir, 'paper-1.21.8-62.jar')), 8000, 'upgrade');
  });

  it('installs the same-version update from the update menu', async () => {
    const { rig, dir, world } = await versionsRig();
    assert.equal(await rig.core.installVersion('paper', '1.21.8', false), true);
    await rig.core.checkUpdates();
    world.setPaperBuild(66);
    await rig.refresh();
    await rig.press('u');
    await screenHas(rig, /Update to Paper 1\.21\.8 build 66/);
    await rig.press(K.enter);
    await screenHas(rig, /│ Install\s+│/);
    await rig.press(K.enter);
    await waitFor(() => existsSync(join(dir, 'paper-1.21.8-66.jar')), 8000, 'update');
    assert.match(rig.screen(), /Updates|Paper/);
  });

  it('says when everything is up to date or the server is not tracked', async () => {
    const { rig } = await versionsRig();
    await rig.press('u');
    await screenHas(rig, /not tracked by MCLI/);
    assert.equal(await rig.core.installVersion('paper', '1.21.8', false), true);
    await rig.core.checkUpdates();
    await rig.press('u');
    await screenHas(rig, /Everything is up to date/);
  });

  it('verifies the jar and repairs it', async () => {
    const { rig, dir } = await versionsRig();
    assert.equal(await rig.core.installVersion('paper', '1.21.8', false), true);
    await rig.press('v');
    await screenHas(rig, /The server jar is intact/);
    await rig.refresh();
    assert.match(rig.screen(), /deep check passed just now/);
    writeFileSync(join(dir, 'paper-1.21.8-59.jar'), 'broken');
    await rig.press('v');
    await screenHas(rig, /Problem:/);
    await rig.refresh();
    assert.match(rig.screen(), /✗/);
    await rig.press('r');
    assert.match(rig.screen(), /Download paper 1\.21\.8 again/);
    await rig.press('y');
    await screenHas(rig, /Repaired\./);
    assert.equal(readFileSync(join(dir, 'paper-1.21.8-59.jar')).length > 1000, true);
  });

  it('has nothing to verify or repair for an empty folder', async () => {
    const { rig } = await versionsRig();
    await rig.press('v');
    await screenHas(rig, /Nothing to verify/);
    await rig.press('r');
    await screenHas(rig, /Cannot repair/);
  });

  it('F refreshes the update check and E opens the EULA question', async () => {
    const { rig } = await versionsRig();
    await rig.press('f');
    assert.match(rig.screen(), /Checking for updates/);
    await rig.press('e');
    assert.match(rig.screen(), /Accept the Minecraft EULA/);
    await rig.press(K.esc, 'z');
  });

  it('manages Java: shows installs, switches to automatic or a fixed one, installs a version, rescans', async () => {
    const { rig, dir } = await versionsRig();
    addFakeJava(dir, 17);
    await rig.press('j');
    await screenHas(rig, /1 Java installation\(s\) found/);
    assert.match(rig.screen(), /Automatic - MCLI picks a fitting Java per server\s+\(current\)/);
    assert.match(rig.screen(), /Java 17 Temurin JRE\s+\[MCLI\]/);
    assert.match(rig.screen(), /Install Java 99 \(Eclipse Temurin\)\s+download/);
    await rig.press(K.down, K.enter);
    assert.match(rig.screen(), /Java fixed to .*fakejdk-17/);
    assert.match(rig.core.cfg.java, /fakejdk-17/);
    await rig.press('j');
    await screenHas(rig, /Fixed to:/);
    assert.match(rig.screen(), /\(current\)/);
    await rig.press(K.enter); // Automatic
    assert.match(rig.screen(), /Java is chosen automatically/);
    assert.equal(rig.core.cfg.java, '');
    await rig.press('j');
    await screenHas(rig, /Java/);
    await rig.press(K.end, K.enter); // Rescan
    await screenHas(rig, /Scan finished/);
    await rig.press('j');
    await screenHas(rig, /Install Java 99/);
    await rig.press(K.end, K.up, K.enter); // Install Java 99
    await screenHas(rig, /Install Java 99 \(Eclipse Temurin JRE/);
    await rig.press(K.esc);
  });

  it('describes the Java situation for the installed server', async () => {
    const { rig, dir } = await versionsRig();
    assert.equal(await rig.core.installVersion('paper', '1.21.8', false), true);
    await rig.refresh();
    assert.match(rig.screen(), /Java\s+✗ no Java 21\+ installed - press J to install it/);
    addFakeJava(dir, 21);
    await rig.core.java.scan();
    await rig.refresh();
    assert.match(rig.screen(), /✓ Java 21 Temurin \(automatic, needs 21\+\)/);
    assert.match(rig.screen(), /1 found on this computer/);
    rig.core.cfg.java = join(dir, 'missing-java');
    await rig.press(K.f(1), K.f(5));
    await waitFor(() => /configured Java not found|checking/.test(rig.screen()), 3000);
    rig.core.cfg.java = addFakeJava(dir, 17);
    await rig.press(K.f(1), K.f(5));
    await waitFor(() => /configured Java 17, server needs 21/.test(rig.screen()), 3000);
    rig.core.cfg.java = addFakeJava(dir, 21);
    await rig.press(K.f(1), K.f(5));
    await waitFor(() => /fixed in settings/.test(rig.screen()), 3000);
  });

  it('shows the activity while a download is running and the buttons react to clicks', async () => {
    const { rig } = await versionsRig();
    rig.core.installer.busy = 'Downloading paper-1.21.8-59.jar - 10 MB of 50 MB';
    rig.core.installer.progress = { done: 10, total: 50 };
    rig.core.java.busy = 'Downloading Java 21';
    rig.core.java.progress = { done: 1, total: 4 };
    await rig.refresh();
    assert.match(rig.screen(), /Downloading paper-1\.21\.8-59\.jar - 10 MB of 50 MB/);
    assert.match(rig.screen(), /20%/);
    assert.match(rig.screen(), /25%/);
    rig.core.installer.busy = null;
    rig.core.java.busy = null;
    await rig.refresh();
    const row = rig.term.lines().findIndex((l) => /I {2}Install \/ switch/.test(l));
    await rig.press(K.click(rig.term.lines()[row].indexOf('Install') + 1, row + 1));
    assert.match(rig.screen(), /Install server software/);
    await rig.press(K.esc, K.click(1, 20), '\x1b[<0;2;20m');
  });

  it('shows a custom launch command instead of an installed server', async () => {
    const dir = tmp('tui');
    const rig = await tuiRig(dir, customLaunch(dir));
    await rig.press(K.f(5));
    assert.match(rig.screen(), /custom launch command from mcli\.json/);
  });

  it('survives an unreachable provider', async () => {
    const dir = tmp('tui');
    const rig = await tuiRig(dir, {}, { endpoints: { mojang: 'http://127.0.0.1:1/x', paper: 'http://127.0.0.1:1/x', fabric: 'http://127.0.0.1:1/x', forgePromos: 'http://127.0.0.1:1/x', forgeMaven: 'http://127.0.0.1:1/x' }, javaVerify: fakeJavaVerify });
    await rig.press(K.f(5), 'i', K.enter);
    await screenHas(rig, /Could not load versions/);
  });
});

describe('Backups view', () => {
  async function backupsRig(running = false): Promise<Rig> {
    const dir = tmp('tui');
    mkdirSync(join(dir, 'world'));
    writeFileSync(join(dir, 'world', 'level.dat'), 'original');
    const rig = await tuiRig(dir, running ? customLaunch(dir) : {});
    if (running) {
      await rig.press('s');
      await waitFor(() => rig.core.server.state === 'running');
    }
    await rig.press(K.f(6));
    return rig;
  }

  it('creates, lists, restores and deletes backups', async () => {
    const rig = await backupsRig();
    assert.match(rig.screen(), /No backups yet\. Press N to create one\./);
    assert.match(rig.screen(), /Worlds\s+world/);
    await rig.press('n');
    await screenHas(rig, /Backup created: backup-\d{8}-\d{6}\.zip/);
    await rig.refresh();
    assert.match(rig.screen(), /Backups \(1\)/);
    assert.match(rig.screen(), /backup-\d{8}-\d{6}\.zip\s+\d+ (B|KB)\s+just now/);

    writeFileSync(join(rig.core.cfg.serverDir, 'world', 'level.dat'), 'damaged');
    await rig.press('r');
    assert.match(rig.screen(), /Restore backup-/);
    await rig.press('y');
    await screenHas(rig, /Backup restored\./);
    assert.equal(readFileSync(join(rig.core.cfg.serverDir, 'world', 'level.dat'), 'utf8'), 'original');

    await rig.press('d');
    assert.match(rig.screen(), /Delete backup-/);
    await rig.press('n');
    assert.equal((await rig.core.backups.list()).length, 1);
    await rig.press(K.del, 'y');
    await screenHas(rig, /Deleted backup-/);
    await waitFor(async () => (await rig.core.backups.list()).length === 0);
  });

  it('opens an action menu and the backup folder', async () => {
    const rig = await backupsRig();
    await rig.press('n');
    await screenHas(rig, /Backup created/);
    const opened: string[] = [];
    const real = folderOpener.open;
    folderOpener.open = (dir) => void opened.push(dir);
    try {
      await rig.press('o');
      assert.deepEqual(opened, [rig.core.backups.dir]);
      await rig.press(K.enter);
      assert.match(rig.screen(), /Restore this backup/);
      await rig.press(K.end, K.enter); // Open backup folder
      assert.equal(opened.length, 2);
      await rig.press(K.enter, K.down, K.down, K.enter); // Create new backup
      await waitFor(async () => (await rig.core.backups.list()).length >= 1);
      await rig.press(K.enter, K.down, K.enter); // Delete this backup
      assert.match(rig.screen(), /Delete backup-/);
      await rig.press(K.esc, K.enter, K.enter); // Restore this backup
      assert.match(rig.screen(), /Restore backup-/);
      await rig.press(K.esc);
    } finally {
      folderOpener.open = real;
    }
  });

  it('will not restore while the server runs, and says when a backup is already running', async () => {
    const rig = await backupsRig(true);
    await rig.press('n');
    await screenHas(rig, /Backup created/);
    await rig.refresh();
    await rig.press('r');
    assert.match(rig.screen(), /Stop the server before restoring a backup/);
    rig.core.backups.busy = 'Zipping 40%';
    await rig.press('n');
    assert.match(rig.screen(), /Busy: Zipping 40%/);
    await rig.refresh();
    assert.match(rig.screen(), /Status\s+Zipping 40%/);
    assert.match(rig.screen().split('\n')[1], /6 Backups …/);
    rig.core.backups.busy = null;
  });

  it('works with the mouse and ignores keys that mean nothing', async () => {
    const rig = await backupsRig();
    await rig.press('n');
    await screenHas(rig, /Backup created/);
    await rig.refresh();
    await rig.press(K.click(5, 11), K.wheelDown, K.wheelUp, 'z', K.down, K.up, K.home, K.end);
    await rig.press('r', 'n'); // restore question, decline
    assert.match(rig.screen(), /Backups/);
    await rig.press('d', K.esc, 'x');
  });

  it('reports a missing world', async () => {
    const dir = tmp('tui');
    const rig = await tuiRig(dir);
    await rig.press(K.f(6));
    assert.match(rig.screen(), /none found yet/);
    await rig.press('n');
    await screenHas(rig, /Backup failed - see the console/);
  });
});
