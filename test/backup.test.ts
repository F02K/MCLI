import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BackupManager, type ServerHooks } from '../src/backup';
import { loadConfig } from '../src/config';
import { extractZip } from '../src/zip';
import { sleep, tmp } from './helpers';

function world(dir: string, name = 'world'): void {
  mkdirSync(join(dir, name, 'region'), { recursive: true });
  writeFileSync(join(dir, name, 'level.dat'), `level of ${name}`);
  writeFileSync(join(dir, name, 'region', 'r.0.0.mca'), Buffer.alloc(30_000, 3));
}

function setup(cfg: Record<string, unknown> = {}, hooks: Partial<ServerHooks> = {}) {
  const dir = tmp('backup');
  writeFileSync(join(dir, 'mcli.json'), JSON.stringify({ serverDir: '.', ...cfg }));
  const sent: string[] = [];
  const infos: string[] = [];
  const full: ServerHooks = {
    isRunning: () => false,
    isStopped: () => true,
    send: (c) => (sent.push(c), true),
    waitForLine: () => Promise.resolve(true),
    ...hooks,
  };
  const mgr = new BackupManager(loadConfig(dir), full);
  mgr.on('info', (t: string) => infos.push(t));
  return { dir, mgr, sent, infos };
}

describe('BackupManager', () => {
  it('finds the world folders from level-name and the Paper nether/end folders', () => {
    const { dir, mgr } = setup();
    assert.deepEqual(mgr.worldFolders(), []);
    world(dir);
    world(dir, 'world_nether');
    assert.deepEqual(mgr.worldFolders(), ['world', 'world_nether']);
    writeFileSync(join(dir, 'server.properties'), 'level-name=survival\n');
    world(dir, 'survival');
    world(dir, 'survival_the_end');
    assert.deepEqual(mgr.worldFolders(), ['survival', 'survival_the_end']);
  });

  it('creates a zip of a stopped server without touching the console', async () => {
    const { dir, mgr, sent, infos } = setup();
    world(dir);
    world(dir, 'world_nether');
    const made = await mgr.create();
    assert.ok(made);
    assert.match(made.name, /^backup-\d{8}-\d{6}\.zip$/);
    assert.ok(made.size > 100);
    assert.deepEqual(sent, []);
    assert.match(infos.join('\n'), /Backup created/);
    assert.ok(mgr.lastBackupAt);
    assert.equal(mgr.busy, null);
    const listed = await mgr.list();
    assert.deepEqual(listed.map((b) => b.name), [made.name]);

    const out = tmp('restore');
    assert.equal(await extractZip(made.path, out), 4);
    assert.equal(readFileSync(join(out, 'world_nether', 'level.dat'), 'utf8'), 'level of world_nether');
  });

  it('pauses saving around the zip while the server runs, and always turns it back on', async () => {
    const waits: RegExp[] = [];
    const { dir, mgr, sent } = setup({}, { isRunning: () => true, waitForLine: (re) => (waits.push(re), Promise.resolve(true)) });
    world(dir);
    assert.ok(await mgr.create());
    assert.deepEqual(sent, ['save-off', 'save-all flush', 'save-on']);
    assert.ok(waits[0].test('[12:00:00] [Server thread/INFO]: Saved the game'));
    assert.ok(waits[0].test('Saved the world'));
  });

  it('warns but continues when the server never confirms the save', async () => {
    const { dir, mgr, infos } = setup({}, { isRunning: () => true, waitForLine: () => Promise.resolve(false) });
    world(dir);
    assert.ok(await mgr.create());
    assert.match(infos.join('\n'), /no save confirmation/);
  });

  it('reports failures and still re-enables saving', async () => {
    const dir0 = tmp('blocker');
    writeFileSync(join(dir0, 'file'), 'x'); // backupDir inside a file cannot be created
    const { dir, mgr, sent, infos } = setup({ backupDir: join(dir0, 'file', 'sub') }, { isRunning: () => true });
    world(dir);
    assert.equal(await mgr.create(), null);
    assert.match(infos.join('\n'), /Backup failed/);
    assert.equal(sent.at(-1), 'save-on');
    assert.equal(mgr.busy, null);
  });

  it('says so when there is no world to back up', async () => {
    const { mgr, infos } = setup();
    assert.equal(await mgr.create(), null);
    assert.match(infos.join('\n'), /no world folder/);
  });

  it('refuses a second backup while one is running', async () => {
    const { dir, mgr, infos } = setup();
    world(dir);
    const first = mgr.create();
    assert.equal(await mgr.create(), null);
    assert.match(infos.join('\n'), /busy/i);
    assert.ok(await first);
  });

  it('keeps only the newest backups (backupKeep) and lists newest first', async () => {
    const { dir, mgr, infos } = setup({ backupKeep: 2 });
    world(dir);
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      const b = await mgr.create();
      assert.ok(b);
      // spread the timestamps so ordering is unambiguous
      const t = new Date(Date.now() - (3 - i) * 60_000);
      utimesSync(b.path, t, t);
      names.push(b.name);
      await sleep(1100); // names have 1 s resolution
    }
    const left = (await mgr.list()).map((b) => b.name);
    assert.equal(left.length, 2);
    assert.ok(!left.includes(names[0]));
    assert.match(infos.join('\n'), /Removed old backup/);
  });

  it('keeps everything when backupKeep is 0', async () => {
    const { dir, mgr } = setup({ backupKeep: 0 });
    world(dir);
    await mgr.create();
    await sleep(1100);
    await mgr.create();
    assert.equal((await mgr.list()).length, 2);
  });

  it('deletes a backup', async () => {
    const { dir, mgr } = setup();
    world(dir);
    const b = await mgr.create();
    let changed = 0;
    mgr.on('change', () => changed++);
    await mgr.remove(b!.name);
    assert.equal(existsSync(b!.path), false);
    assert.ok(changed > 0);
    assert.deepEqual(await mgr.list(), []);
  });

  it('restores a backup and renames (not deletes) the current worlds', async () => {
    const { dir, mgr, infos } = setup();
    world(dir);
    const b = await mgr.create();
    writeFileSync(join(dir, 'world', 'level.dat'), 'CORRUPTED');
    assert.equal(await mgr.restore(b!.name), true);
    assert.equal(readFileSync(join(dir, 'world', 'level.dat'), 'utf8'), 'level of world');
    const renamed = readdirSync(dir).filter((n) => n.startsWith('world.pre-restore-'));
    assert.equal(renamed.length, 1);
    assert.equal(readFileSync(join(dir, renamed[0], 'level.dat'), 'utf8'), 'CORRUPTED');
    assert.match(infos.join('\n'), /Restored/);
  });

  it('will not restore while the server runs, nor with a missing archive', async () => {
    const running = setup({}, { isStopped: () => false });
    world(running.dir);
    const b = await running.mgr.create();
    assert.equal(await running.mgr.restore(b!.name), false);
    assert.match(running.infos.join('\n'), /Stop the server/);

    const { dir, mgr, infos } = setup();
    world(dir);
    assert.equal(await mgr.restore('nope.zip'), false);
    assert.match(infos.join('\n'), /Restore failed/);
    assert.equal(mgr.busy, null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists nothing when the backup folder does not exist', async () => {
    assert.deepEqual(await setup().mgr.list(), []);
  });
});
