import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Core } from '../src/core';
import { isNewerIdentity } from '../src/core';
import { writeInstallMeta } from '../src/installmeta';
import { addFakeJava, customLaunch, fakeJavaVerify, freePort, makeCore, makeJar, providerWorld, sleep, tmp, waitFor } from './helpers';

const infos = (core: Core): string => core.logs.filter((l) => l.src === 'mcli').map((l) => l.text).join('\n');
const argsFile = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';

/** A server folder with a launchable-looking vanilla jar and install metadata. */
async function vanillaDir(javaMajor?: number): Promise<string> {
  const dir = tmp('core');
  await makeJar(join(dir, 'minecraft_server.1.21.8.jar'), { main: 'net.minecraft.bundler.Main' });
  writeInstallMeta(dir, { provider: 'vanilla', mcVersion: '1.21.8', identity: '1.21.8', file: 'minecraft_server.1.21.8.jar', javaMajor, installedAt: 'x' });
  return dir;
}

describe('isNewerIdentity', () => {
  it('compares build identities numerically', () => {
    assert.equal(isNewerIdentity('60', '50'), true);
    assert.equal(isNewerIdentity('100', '99'), true);
    assert.equal(isNewerIdentity('60', '60'), false);
    assert.equal(isNewerIdentity('59', '60'), false);
    assert.equal(isNewerIdentity('47.4.10', '47.2.0'), true);
    assert.equal(isNewerIdentity('14.23.5.2859', '14.23.5.2860'), false);
    assert.equal(isNewerIdentity('0.19.5/1.1.2', '0.17.2/1.1.0'), true);
  });
});

describe('Core basics', () => {
  it('describes the server and keeps a capped, timestamped log', () => {
    const dir = tmp('core');
    const core = makeCore(dir);
    assert.equal(core.describeServer(), 'no server detected');
    core.info('hello');
    assert.match(core.logs[0].text, /^\[\d\d:\d\d:\d\d\] \[MCLI\] hello$/);
    for (let i = 0; i < 5100; i++) core.addLog(`line ${i}`, 'server');
    assert.equal(core.logs.length, 5000);
    assert.equal(core.logs.at(-1)?.text, 'line 5099');
    const custom = makeCore(tmp('core'), customLaunch(tmp('x')));
    assert.equal(custom.describeServer(), 'custom launch');
  });

  it('shows the banner with detection result', async () => {
    const dir = await vanillaDir();
    const core = makeCore(dir);
    core.banner();
    assert.match(infos(core), /Detected: vanilla 1\.21\.8/);
    assert.match(infos(core), /Type :start/);
  });

  it('answers MCLI commands: help, unknown, status, versions usage', () => {
    const core = makeCore(tmp('core'));
    core.exec(':help');
    assert.match(core.logs.map((l) => l.text).join('\n'), /MCLI commands/);
    core.exec(':nonsense');
    assert.match(infos(core), /Unknown command "nonsense"/);
    core.exec(':status');
    assert.match(infos(core), /no server detected \| state: stopped/);
    core.exec(':versions');
    assert.match(infos(core), /Usage: :versions/);
    core.exec(':install');
    assert.match(infos(core), /Usage: :install/);
    core.exec(':stop');
    assert.match(infos(core), /not running/);
    core.exec('say hi');
    assert.match(infos(core), /Server is not running/);
  });

  it('reports problems and reachability in :status', () => {
    const core = makeCore(tmp('core'));
    core.addProblem({ id: 'x', title: 'Something is wrong', advice: 'Fix it', fatal: false });
    core.exec(':status');
    assert.match(infos(core), /PROBLEM: Something is wrong\. Fix it/);
    core.health = { reachable: true, everReachable: true, failures: 0, host: '127.0.0.1', port: 25565, version: '1.21.8', online: 1, max: 20, latencyMs: 3 };
    core.exec(':status');
    assert.match(infos(core), /Reachable on 127\.0\.0\.1:25565 - 1\.21\.8, 1\/20 players/);
  });

  it('adds, de-duplicates and removes problems', () => {
    const core = makeCore(tmp('core'));
    const seen: string[] = [];
    core.on('problem', (p: { id: string }) => seen.push(p.id));
    const p = { id: 'a', title: 'A', advice: 'a', fatal: false };
    core.addProblem(p);
    core.addProblem(p);
    assert.equal(core.problems.length, 1);
    assert.deepEqual(seen, ['a']);
    core.removeProblem('nope');
    core.removeProblem('a');
    assert.equal(core.problems.length, 0);
    core.clearProblems(); // nothing to clear: no event
    core.addProblem(p);
    core.clearProblems();
    assert.equal(core.problems.length, 0);
  });

  it('waitForLine resolves on a match, on timeout and when the server stops', async () => {
    const core = makeCore(tmp('core'));
    const hit = core.waitForLine(/saved/i, 1000);
    core.server.emit('line', 'World Saved!');
    assert.equal(await hit, true);
    assert.equal(await core.waitForLine(/never/, 50), false);
    const stopped = core.waitForLine(/never/, 1000);
    core.server.emit('state', 'stopped');
    assert.equal(await stopped, false);
  });

  it('accepts the EULA by writing eula.txt and clearing the problem', () => {
    const dir = tmp('core');
    const core = makeCore(dir);
    core.addProblem({ id: 'eula', title: 'EULA', advice: '', fatal: true });
    core.acceptEula();
    assert.match(readFileSync(join(dir, 'eula.txt'), 'utf8'), /\neula=true\n$/);
    assert.equal(core.problems.length, 0);
  });
});

describe('Core running a server', () => {
  it('starts, echoes commands, tracks players and stops', async () => {
    const dir = tmp('core');
    const core = makeCore(dir, customLaunch(dir));
    await core.startServer();
    await waitFor(() => core.server.state === 'running');
    await core.startServer(); // already running
    assert.match(infos(core), /already running/);
    core.exec('join Steve');
    await waitFor(() => core.players.online.has('Steve'));
    assert.match(infos(core), /› join Steve/);
    core.exec(':stop');
    await waitFor(() => core.server.state === 'stopped');
    assert.equal(core.players.online.size, 0);
  });

  it(':restart restarts and :start works again afterwards', async () => {
    const dir = tmp('core');
    const core = makeCore(dir, customLaunch(dir));
    core.exec(':start');
    await waitFor(() => core.server.state === 'running');
    const pid = core.server.pid;
    core.exec(':restart');
    await waitFor(() => core.server.state === 'running' && core.server.pid !== pid, 8000, 'new process');
    await core.server.stop();
  });

  it('refuses to start while the installer is busy', async () => {
    const dir = tmp('core');
    const core = makeCore(dir, customLaunch(dir));
    core.installer.busy = 'Downloading x';
    await core.startServer();
    assert.match(infos(core), /Wait for the installer/);
    assert.equal(core.server.state, 'stopped');
  });

  it('shutdown stops the server, exits 0, and a second request forces exit 1', async () => {
    const dir = tmp('core');
    const core = makeCore(dir, customLaunch(dir));
    const codes: number[] = [];
    core.exit = (c) => void codes.push(c);
    await core.startServer();
    await waitFor(() => core.server.state === 'running');
    const quitting: boolean[] = [];
    core.on('quitting', () => quitting.push(true));
    await core.shutdown();
    assert.deepEqual(codes, [0]);
    assert.equal(core.quitting, true);
    assert.equal(quitting.length, 1);
    await core.shutdown();
    assert.deepEqual(codes, [0, 1]);
    assert.match(infos(core), /Forcing exit/);
  });

  it(':quit shuts down', async () => {
    const core = makeCore(tmp('core'));
    const codes: number[] = [];
    core.exit = (c) => void codes.push(c);
    core.exec(':quit');
    await waitFor(() => codes.length > 0);
    assert.deepEqual(codes, [0]);
  });

  it('creates automatic backups while the server runs', async () => {
    const dir = tmp('core');
    mkdirSync(join(dir, 'world'));
    writeFileSync(join(dir, 'world', 'level.dat'), 'x');
    const core = makeCore(dir, { ...customLaunch(dir), backupIntervalMinutes: 0.0005 }, { backupCheckMs: 40 });
    await core.startServer();
    await waitFor(() => core.server.state === 'running');
    await waitFor(() => /Automatic backup/.test(infos(core)) && core.backups.lastBackupAt, 8000, 'automatic backup');
    await waitFor(() => !core.backups.busy);
    assert.ok((await core.backups.list()).length >= 1);
    await core.server.stop();
  });
});

describe('Core preflight', () => {
  const opts = { javaVerify: fakeJavaVerify };

  it('reports a missing server', async () => {
    const core = makeCore(tmp('core'), {}, opts);
    assert.equal(await core.preflight(), false);
    assert.deepEqual(core.problems.map((p) => p.id), ['no-server']);
    await core.startServer();
    assert.match(infos(core), /Not starting: No server found/);
  });

  it('blocks a broken jar', async () => {
    const dir = tmp('core');
    writeFileSync(join(dir, 'server.jar'), 'html error page');
    const core = makeCore(dir, {}, opts);
    assert.equal(await core.preflight(), false);
    assert.equal(core.problems[0].id, 'jar-broken');
    assert.match(core.problems[0].advice, /Versions/);
  });

  it('picks the lowest fitting Java and remembers it for the launch', async () => {
    const dir = await vanillaDir(17);
    const core = makeCore(dir, {}, opts);
    const j17 = addFakeJava(dir, 17);
    addFakeJava(dir, 21);
    assert.equal(await core.preflight(), true, core.problems.map((p) => p.title).join());
    assert.equal(core.server.javaPath, j17);
    assert.match(infos(core), /Using Java 17/);
    await core.preflight();
    assert.equal(infos(core).match(/Using Java 17/g)?.length, 1, 'the note is only logged once');
  });

  it('offers to install a missing Java version', async () => {
    const dir = await vanillaDir(99);
    const core = makeCore(dir, {}, opts);
    addFakeJava(dir, 17);
    assert.equal(await core.preflight(), false);
    const p = core.problems[0];
    assert.equal(p.id, 'java-install');
    assert.equal(p.javaMajor, 99);
    assert.equal(p.action, 'java-install');
    assert.equal(p.fatal, true);
  });

  it('with javaAutoInstall it downloads the missing Java and goes on', async () => {
    const world = await providerWorld();
    const dir = await vanillaDir(99);
    const core = makeCore(dir, { javaAutoInstall: true }, { javaVerify: fakeJavaVerify, javaApi: world.javaApi });
    assert.equal(await core.preflight(), true, `${core.problems.map((p) => p.title).join()} ${infos(core)}`);
    assert.match(core.server.javaPath ?? '', /fakejdk-99/);
    assert.match(infos(core), /installing it automatically/);
  });

  it('installJava installs on request and clears Java problems', async () => {
    const world = await providerWorld();
    const dir = await vanillaDir(99);
    const core = makeCore(dir, {}, { javaVerify: fakeJavaVerify, javaApi: world.javaApi });
    await core.preflight();
    assert.equal(core.problems[0].id, 'java-install');
    assert.equal(await core.installJava(99), true);
    assert.equal(core.problems.length, 0);
    assert.equal(await core.preflight(), true);
    assert.equal(await core.installJava(98), false, 'unknown version fails cleanly');
  });

  it('keeps a fixed Java from settings and explains when it does not fit or exist', async () => {
    const dir = await vanillaDir(99);
    const fixed = addFakeJava(dir, 17);
    let core = makeCore(dir, { java: fixed }, opts);
    assert.equal(await core.preflight(), false);
    assert.equal(core.problems[0].id, 'java-old');
    assert.match(core.problems[0].title, /needs Java 99\+, but the configured Java is 17/);

    const dir2 = await vanillaDir(17);
    core = makeCore(dir2, { java: join(dir2, 'nope', 'java') }, opts);
    assert.equal(await core.preflight(), false);
    assert.equal(core.problems[0].id, 'java-missing');

    const dir3 = await vanillaDir(17);
    const fine = addFakeJava(dir3, 21);
    core = makeCore(dir3, { java: fine }, opts);
    assert.equal(await core.preflight(), true);
  });

  it('old Forge only accepts exactly Java 8', async () => {
    const dir = tmp('core');
    const lib = join(dir, 'libraries', 'net', 'minecraftforge', 'forge', '1.12.2-14.23.5.2860');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, argsFile), '');
    writeInstallMeta(dir, { provider: 'forge', mcVersion: '1.12.2', identity: '14.23.5.2860', file: 'installer.jar', javaMajor: 8, installedAt: 'x' });
    addFakeJava(dir, 17);
    const core = makeCore(dir, {}, opts);
    assert.equal(await core.preflight(), false);
    assert.equal(core.problems[0].javaMajor, 8);
    addFakeJava(dir, 8);
    assert.equal(await core.preflight(), true);
  });

  it('wants the EULA accepted', async () => {
    const dir = await vanillaDir(17);
    addFakeJava(dir, 17);
    writeFileSync(join(dir, 'eula.txt'), 'eula=false\n');
    const core = makeCore(dir, {}, opts);
    assert.equal(await core.preflight(), false);
    assert.equal(core.problems[0].id, 'eula');
    core.acceptEula();
    assert.equal(await core.preflight(), true);
  });

  it('notices a busy server port', async () => {
    const dir = await vanillaDir(17);
    addFakeJava(dir, 17);
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(0, '0.0.0.0', r));
    const port = (busy.address() as { port: number }).port;
    writeFileSync(join(dir, 'server.properties'), `server-port=${port}\n`);
    const core = makeCore(dir, {}, opts);
    assert.equal(await core.preflight(), false);
    assert.equal(core.problems[0].id, 'port');
    await new Promise<void>((r) => busy.close(() => r()));
    assert.equal(await core.preflight(), true);
  });

  it('learns the Java requirement from a startup error and retries silently when it is installed', async () => {
    const dir = tmp('core');
    const failing = `console.log('java.lang.UnsupportedClassVersionError: a (class file version 69.0), this version only recognizes class file versions up to 65.0'); process.exit(1);`;
    writeInstallMeta(dir, { provider: 'paper', mcVersion: '26.2', identity: '1', file: 'x.jar', installedAt: 'x' });
    const core = makeCore(dir, customLaunch(dir, failing), opts);
    addFakeJava(dir, 25);
    await core.java.scan();
    const seen: string[] = [];
    core.on('problem', (p: { id: string }) => seen.push(p.id));
    await core.startServer();
    await waitFor(() => infos(core).match(/Starting:/g)?.length === 2 && core.server.state === 'stopped', 8000, 'retry');
    assert.match(infos(core), /needs Java 25, which is installed - restarting/);
    const meta = JSON.parse(readFileSync(join(dir, 'mcli-install.json'), 'utf8')) as { javaMajor: number };
    assert.equal(meta.javaMajor, 25);
    assert.deepEqual(seen, ['java-old'], 'only the repeated failure raises a problem');
  });

  it('with a fixed Java the learned requirement points at the settings instead', async () => {
    const dir = tmp('core');
    const failing = `console.log('Unsupported class file major version 69'); process.exit(1);`;
    const fixed = addFakeJava(dir, 17);
    const core = makeCore(dir, { ...customLaunch(dir, failing), java: fixed }, opts);
    await core.startServer();
    await waitFor(() => core.problems.some((p) => p.id === 'java-old'));
    const p = core.problems.find((x) => x.id === 'java-old');
    assert.equal(p?.action, 'settings');
    assert.match(p?.advice ?? '', /Clear "java"/);
  });
});

describe('Core health', () => {
  const pingServerScript = (port: number, answers: string) => `
    const net = require('net');
    const v = (n) => { const b = []; do { let x = n & 127; n >>>= 7; if (n) x |= 128; b.push(x); } while (n); return Buffer.from(b); };
    ${answers}
    const srv = net.createServer((s) => s.on('error', () => {}).once('data', () => {
      if (!answer()) { s.destroy(); return; }
      const j = Buffer.from(JSON.stringify({ version: { name: '1.21.8', protocol: 772 }, players: { max: 12, online: 0 }, description: 'fake' }));
      const body = Buffer.concat([v(0), v(j.length), j]);
      s.write(Buffer.concat([v(body.length), body]));
    })).listen(${port}, '127.0.0.1');
    console.log('booting');
    require('readline').createInterface({ input: process.stdin }).on('line', (l) => { if (l === 'stop') process.exit(0); });`;

  it('flips a starting server to running when it answers a status ping', async () => {
    const dir = tmp('core');
    const port = await freePort();
    writeFileSync(join(dir, 'server.properties'), `server-port=${port}\n`);
    const core = makeCore(dir, customLaunch(dir, pingServerScript(port, 'const answer = () => true;')), { healthMs: 60 });
    await core.startServer();
    await waitFor(() => core.server.state === 'running', 8000, 'running via ping');
    assert.equal(core.health.reachable, true);
    assert.equal(core.health.version, '1.21.8');
    assert.equal(core.players.max, 12);
    assert.match(infos(core), /Server answers on 127\.0\.0\.1/);
    await core.server.stop();
    await waitFor(() => core.health.reachable === null);
  });

  it('flags a running server that stops answering', async () => {
    const dir = tmp('core');
    const port = await freePort();
    writeFileSync(join(dir, 'server.properties'), `server-port=${port}\n`);
    const script = pingServerScript(port, 'let n = 0; const answer = () => ++n <= 2;') + `setTimeout(() => console.log('Done (0.1s)! For help'), 50);`;
    const core = makeCore(dir, customLaunch(dir, script), { healthMs: 40 });
    await core.startServer();
    await waitFor(() => core.problems.some((p) => p.id === 'not-responding'), 10_000, 'frozen detection');
    assert.equal(core.server.state, 'running');
    assert.match(core.problems[0].advice, /No reply on port/);
    await core.server.stop();
  });

  it('warns when a server takes very long to start', async () => {
    const dir = tmp('core');
    const core = makeCore(dir, customLaunch(dir, 'setInterval(() => {}, 1000); console.log("booting");'), { healthMs: 40, slowStartMs: 100 });
    await core.startServer();
    await waitFor(() => core.problems.some((p) => p.id === 'slow-start'), 8000, 'slow start');
    core.server.kill();
    await sleep(50);
  });
});
