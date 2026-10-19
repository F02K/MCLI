import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { detectServer } from '../src/detect';
import { Installer, type InstallerDeps } from '../src/installer';
import type { DownloadPlan } from '../src/providers';
import { makeJar, mockHttp, tmp } from './helpers';

const argsName = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';

async function rig(opts: Partial<InstallerDeps> = {}) {
  const jar = join(tmp('inst-src'), 'paper.jar');
  await makeJar(jar, { main: 'io.papermc.paperclip.Main' });
  const body = readFileSync(jar);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const mock = await mockHttp((req, res) => {
    if (req.url === '/paper-1.21.8-99.jar' || req.url === '/forge-installer.jar') {
      res.writeHead(200, { 'content-length': body.length });
      res.end(body);
    } else if (req.url === '/cut.jar') {
      res.writeHead(200, { 'content-length': body.length });
      res.write(body.subarray(0, 500));
      setTimeout(() => res.destroy(), 30);
    } else if (req.url === '/html.jar') {
      res.end('<html>error</html>');
    } else {
      res.writeHead(404);
      res.end('no');
    }
  });
  const dir = tmp('inst');
  const logs: string[] = [];
  const calls = { backup: 0, installed: 0 };
  const installer = new Installer({
    serverDir: dir,
    isStopped: () => true,
    hasWorlds: () => true,
    backup: () => (calls.backup++, Promise.resolve(true)),
    javaCommand: () => 'java',
    log: (t) => logs.push(t),
    onInstalled: () => calls.installed++,
    ...opts,
  });
  const plan = (file: string, over: Partial<DownloadPlan> = {}): DownloadPlan => ({
    provider: 'paper', mcVersion: '1.21.8', identity: '99', filename: 'paper-1.21.8-99.jar', url: `${mock.base}/${file}`,
    kind: 'jar', sha256, size: body.length, display: 'Paper 1.21.8 build 99', javaMajor: 21, ...over,
  });
  return { dir, installer, logs, calls, plan, jar };
}

describe('Installer', () => {
  it('rejects bad downloads and leaves the existing server untouched', async () => {
    const { dir, installer, logs, plan, jar } = await rig();
    writeFileSync(join(dir, 'paper-1.21.1-50.jar'), readFileSync(jar));
    assert.equal(await installer.install(plan('paper-1.21.8-99.jar', { sha256: 'deadbeef' }), { backupFirst: false }), false);
    assert.match(logs.at(-1) ?? '', /checksum mismatch/);
    assert.equal(await installer.install(plan('cut.jar'), { backupFirst: false }), false);
    assert.equal(await installer.install(plan('missing.jar'), { backupFirst: false }), false);
    assert.match(logs.at(-1) ?? '', /404/);
    assert.equal(await installer.install(plan('html.jar', { sha256: undefined, size: undefined }), { backupFirst: false }), false);
    assert.match(logs.at(-1) ?? '', /broken/);
    assert.deepEqual(readdirSync(dir).sort(), ['paper-1.21.1-50.jar']);
  });

  it('installs, retires old jars of every family and records the metadata', async () => {
    const { dir, installer, calls, plan, jar } = await rig();
    for (const old of ['paper-1.21.1-50.jar', 'minecraft_server.1.21.1.jar', 'fabric-server-launch.jar', 'forge-1.12.2-14.23.5.2860.jar', 'server.jar']) {
      writeFileSync(join(dir, old), readFileSync(jar));
    }
    let changes = 0;
    installer.on('change', () => changes++);
    assert.equal(await installer.install(plan('paper-1.21.8-99.jar'), { backupFirst: true }), true);
    assert.equal(calls.backup, 1);
    assert.equal(calls.installed, 1);
    assert.ok(changes > 0);
    assert.equal(installer.busy, null);
    assert.ok(existsSync(join(dir, 'paper-1.21.8-99.jar')));
    assert.equal(readdirSync(join(dir, 'old-jars')).length, 5);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.jar')), ['paper-1.21.8-99.jar']);
    const meta = JSON.parse(readFileSync(join(dir, 'mcli-install.json'), 'utf8')) as { identity: string; javaMajor: number; sha256: string };
    assert.equal(meta.identity, '99');
    assert.equal(meta.javaMajor, 21);
    assert.match(meta.sha256, /^[0-9a-f]{64}$/);
    assert.equal(detectServer(dir)?.jar, 'paper-1.21.8-99.jar');
  });

  it('numbers colliding names in old-jars/', async () => {
    const { dir, installer, plan, jar } = await rig();
    mkdirSync(join(dir, 'old-jars'));
    writeFileSync(join(dir, 'old-jars', 'paper-1.21.1-50.jar'), 'earlier');
    writeFileSync(join(dir, 'paper-1.21.1-50.jar'), readFileSync(jar));
    assert.equal(await installer.install(plan('paper-1.21.8-99.jar'), { backupFirst: false }), true);
    assert.deepEqual(readdirSync(join(dir, 'old-jars')).sort(), ['1-paper-1.21.1-50.jar', 'paper-1.21.1-50.jar']);
  });

  it('cancels when the pre-install backup fails', async () => {
    const { dir, installer, logs, plan } = await rig({ backup: () => Promise.resolve(false) });
    assert.equal(await installer.install(plan('paper-1.21.8-99.jar'), { backupFirst: true }), false);
    assert.match(logs.at(-1) ?? '', /backup failed/);
    assert.equal(existsSync(join(dir, 'paper-1.21.8-99.jar')), false);
  });

  it('skips the backup when there is no world', async () => {
    const { installer, calls, plan } = await rig({ hasWorlds: () => false });
    assert.equal(await installer.install(plan('paper-1.21.8-99.jar'), { backupFirst: true }), true);
    assert.equal(calls.backup, 0);
  });

  it('refuses while the server runs and while another install is busy', async () => {
    const running = await rig({ isStopped: () => false });
    assert.equal(await running.installer.install(running.plan('paper-1.21.8-99.jar'), { backupFirst: false }), false);
    assert.match(running.logs.at(-1) ?? '', /Stop the server/);

    const { installer, logs, plan } = await rig();
    const first = installer.install(plan('paper-1.21.8-99.jar'), { backupFirst: false });
    assert.equal(await installer.install(plan('paper-1.21.8-99.jar'), { backupFirst: false }), false);
    assert.match(logs.join('\n'), /busy/);
    assert.equal(await first, true);
  });

  it('runs the Forge installer, removes it afterwards and detects the result', async () => {
    const ran: string[][] = [];
    const { dir, installer, logs, plan } = await rig({
      run: (command, args, cwd, onLine) => {
        ran.push([command, ...args]);
        const lib = join(cwd, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.3.0');
        mkdirSync(lib, { recursive: true });
        writeFileSync(join(lib, argsName), '');
        onLine('Downloading libraries...');
        return Promise.resolve();
      },
    });
    const forgePlan = plan('forge-installer.jar', { provider: 'forge', mcVersion: '1.20.1', identity: '47.3.0', filename: 'forge-1.20.1-47.3.0-installer.jar', kind: 'forge-installer', javaMajor: 17 });
    assert.equal(await installer.install(forgePlan, { backupFirst: false }), true);
    assert.deepEqual(ran[0].slice(0, 2), ['java', '-jar']);
    assert.ok(ran[0].includes('--installServer'));
    assert.ok(logs.some((l) => l.startsWith('[forge-installer]')));
    assert.equal(existsSync(join(dir, 'forge-1.20.1-47.3.0-installer.jar')), false);
    assert.equal(detectServer(dir)?.type, 'forge');
  });

  it('reports a failing Forge installer with its last output line', async () => {
    const { installer, logs, plan } = await rig({
      run: (_c, _a, _cwd, onLine) => {
        onLine('Failed to download libraries');
        return Promise.reject(new Error('exit code 1'));
      },
    });
    const forgePlan = plan('forge-installer.jar', { provider: 'forge', filename: 'forge-1.20.1-47.3.0-installer.jar', kind: 'forge-installer' });
    assert.equal(await installer.install(forgePlan, { backupFirst: false }), false);
    assert.match(logs.at(-1) ?? '', /Forge installer failed: exit code 1 \(Failed to download libraries\)/);
  });

  it('the default process runner reports a missing java binary', async () => {
    const { installer, logs, plan } = await rig({ javaCommand: () => 'definitely-not-java' });
    const forgePlan = plan('forge-installer.jar', { provider: 'forge', filename: 'forge-1.20.1-47.3.0-installer.jar', kind: 'forge-installer' });
    assert.equal(await installer.install(forgePlan, { backupFirst: false }), false);
    assert.match(logs.at(-1) ?? '', /could not start/);
  });

  it('the default process runner reports a non-zero exit', async () => {
    const { installer, logs, plan } = await rig({ javaCommand: () => process.execPath });
    const forgePlan = plan('forge-installer.jar', { provider: 'forge', filename: 'forge-1.20.1-47.3.0-installer.jar', kind: 'forge-installer' });
    assert.equal(await installer.install(forgePlan, { backupFirst: false }), false);
    assert.match(logs.at(-1) ?? '', /Forge installer failed: exit code/);
  });
});
