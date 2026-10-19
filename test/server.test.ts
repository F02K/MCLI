import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config';
import { resolveJava, ServerProcess } from '../src/server';
import { FAKE_SERVER, tmp, waitFor } from './helpers';

interface Rig {
  dir: string;
  server: ServerProcess;
  lines: string[];
  infos: string[];
  states: string[];
  problems: string[];
}

function rig(script: string | null, cfg: Record<string, unknown> = {}, delays: [number, number] = [30, 30_000]): Rig {
  const dir = tmp('server');
  if (script !== null) writeFileSync(join(dir, 'fake.js'), script);
  writeFileSync(
    join(dir, 'mcli.json'),
    JSON.stringify({ serverDir: '.', ...(script === null ? {} : { customLaunch: { command: process.execPath, args: ['fake.js'] } }), ...cfg }),
  );
  const server = new ServerProcess(loadConfig(dir), delays[0], delays[1]);
  const r: Rig = { dir, server, lines: [], infos: [], states: [], problems: [] };
  server.on('line', (l: string) => r.lines.push(l));
  server.on('info', (t: string) => r.infos.push(t));
  server.on('state', (s: string) => r.states.push(s));
  server.on('problem', (p: { id: string }) => r.problems.push(p.id));
  return r;
}

describe('ServerProcess lifecycle', () => {
  it('goes starting -> running when the server logs "Done" and stops gracefully', async () => {
    const r = rig(FAKE_SERVER);
    r.server.start();
    assert.equal(r.server.state, 'starting');
    assert.ok(r.server.pid);
    assert.ok(r.server.startedAt);
    assert.match(r.server.launchLine, /fake\.js/);
    await waitFor(() => r.server.state === 'running', 5000, 'running');
    assert.equal(r.server.everReady, true);
    assert.ok(r.lines.some((l) => l.includes('Done (')));

    assert.equal(r.server.send('join Steve'), true);
    await waitFor(() => r.lines.some((l) => l.includes('Steve joined')), 3000, 'echo');

    await r.server.stop();
    assert.equal(r.server.state, 'stopped');
    assert.deepEqual(r.states, ['starting', 'running', 'stopping', 'stopped']);
    assert.equal(r.server.startedAt, null);
    assert.equal(r.server.send('list'), false);
    assert.equal(r.server.restarts, 0);
  });

  it('refuses to start twice and ignores stop when nothing runs', async () => {
    const r = rig(FAKE_SERVER);
    r.server.start();
    r.server.start();
    assert.ok(r.infos.some((i) => /already starting/.test(i)));
    await waitFor(() => r.server.state === 'running');
    await r.server.stop();
    await r.server.stop(); // no process: resolves immediately
  });

  it('restart() stops and starts again', async () => {
    const r = rig(FAKE_SERVER);
    r.server.start();
    await waitFor(() => r.server.state === 'running');
    const firstPid = r.server.pid;
    await r.server.restart();
    await waitFor(() => r.server.state === 'running');
    assert.notEqual(r.server.pid, firstPid);
    await r.server.stop();
  });

  it('marks a starting server as running when told to (status ping succeeded)', async () => {
    const r = rig('setInterval(() => {}, 1000); console.log("booting");');
    r.server.start();
    await waitFor(() => r.lines.includes('booting'));
    assert.equal(r.server.state, 'starting');
    r.server.markRunning();
    assert.equal(r.server.state, 'running');
    r.server.markRunning(); // second call is a no-op
    assert.equal(r.states.filter((s) => s === 'running').length, 1);
    r.server.kill();
    await waitFor(() => r.server.state === 'stopped');
  });

  it('kills a server that ignores the stop command after the timeout', async () => {
    const r = rig('setInterval(() => {}, 1000); console.log("Done (0.1s)! For help, type \\"help\\"");', {}, [30, 200]);
    r.server.start();
    await waitFor(() => r.server.state === 'running');
    await r.server.stop();
    assert.equal(r.server.state, 'stopped');
    assert.ok(r.infos.some((i) => /did not stop in time/.test(i)));
  });

  it('splits output into lines across chunks and handles CRLF and a missing final newline', async () => {
    const r = rig('process.stdout.write("one\\r\\ntw"); setTimeout(() => process.stdout.write("o\\nlast"), 50); setTimeout(() => process.exit(0), 150);');
    r.server.start();
    await waitFor(() => r.server.state === 'stopped', 5000);
    assert.deepEqual(r.lines, ['one', 'two', 'last']);
  });
});

describe('ServerProcess crash handling', () => {
  const crashing = `console.log('Done (0.1s)! For help, type "help"'); setTimeout(() => process.exit(1), 100);`;

  it('restarts after a crash up to maxRestarts, then gives up', async () => {
    const r = rig(crashing, { maxRestarts: 2 });
    r.server.start();
    await waitFor(() => r.infos.some((i) => /crashed 2 times in a row/.test(i)), 8000, 'give up');
    assert.equal(r.infos.filter((i) => i.startsWith('Starting:')).length, 3);
    assert.equal(r.server.state, 'stopped');
    assert.ok(r.infos.some((i) => /restarting in/.test(i)));
  });

  it('does not restart when autoRestart is off', async () => {
    const r = rig(crashing, { autoRestart: false });
    r.server.start();
    await waitFor(() => r.server.state === 'stopped' && r.infos.some((i) => /exited with code 1/.test(i)), 5000);
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(r.infos.filter((i) => i.startsWith('Starting:')).length, 1);
  });

  it('does not restart after a clean exit or a requested stop', async () => {
    const r = rig('console.log("Done (0.1s)! For help"); setTimeout(() => process.exit(0), 100);');
    r.server.start();
    await waitFor(() => r.server.state === 'stopped', 5000);
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(r.infos.filter((i) => i.startsWith('Starting:')).length, 1);
  });

  it('does not restart blindly after a fatal problem such as the EULA', async () => {
    const r = rig('console.log("[ERROR]: You need to agree to the EULA in order to run the server."); process.exit(1);');
    r.server.start();
    await waitFor(() => r.server.state === 'stopped' && r.problems.length > 0, 5000);
    await new Promise((res) => setTimeout(res, 150));
    assert.deepEqual(r.problems, ['eula']);
    assert.ok(r.infos.some((i) => /Not restarting automatically/.test(i)));
    assert.equal(r.infos.filter((i) => i.startsWith('Starting:')).length, 1);
    assert.equal(r.server.problems[0].fatal, true);
  });

  it('flags a start that dies without any known cause', async () => {
    const r = rig('process.exit(3);', { autoRestart: false });
    r.server.start();
    await waitFor(() => r.problems.includes('startup-failed'), 5000);
    assert.equal(r.server.everReady, false);
  });

  it('reports a missing java executable as a problem', async () => {
    const r = rig(null, { customLaunch: { command: 'definitely-not-a-real-command', args: [] }, autoRestart: false });
    r.server.start();
    await waitFor(() => r.problems.includes('java-missing'), 5000);
    assert.equal(r.server.state, 'stopped');
    assert.ok(r.infos.some((i) => /Failed to launch/.test(i)));
  });
});

describe('ServerProcess command line', () => {
  it('says so when there is no server in the folder', () => {
    const r = rig(null);
    r.server.start();
    assert.equal(r.server.state, 'stopped');
    assert.ok(r.infos.some((i) => /No Minecraft server found/.test(i)));
  });

  it('builds java -Xms -Xmx -jar <jar> nogui, preferring cfg.java over the automatic choice', () => {
    const r = rig(null, { java: process.execPath, minMemory: '64M', maxMemory: '128M', autoRestart: false });
    writeFileSync(join(r.dir, 'minecraft_server.1.21.8.jar'), 'not really a jar');
    r.server.javaPath = 'automatic-java';
    r.server.start();
    assert.equal(r.server.launchLine, `${process.execPath} -Xms64M -Xmx128M -jar minecraft_server.1.21.8.jar nogui`);
    r.server.kill();
  });

  it('uses the automatic Java when cfg.java is empty', () => {
    const r = rig(null, { autoRestart: false });
    writeFileSync(join(r.dir, 'server.jar'), 'x');
    r.server.javaPath = process.execPath;
    r.server.start();
    assert.ok(r.server.launchLine.startsWith(process.execPath));
    r.server.kill();
  });

  it('leaves memory flags to Forge\'s own args files', () => {
    const r = rig(null, { java: process.execPath, autoRestart: false });
    const lib = join(r.dir, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.2.0');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt'), '');
    r.server.start();
    assert.ok(!r.server.launchLine.includes('-Xmx'));
    assert.match(r.server.launchLine, /@libraries\/net\/minecraftforge/);
    r.server.kill();
  });
});

describe('resolveJava', () => {
  it('prefers the configured path, then JAVA_HOME, then plain "java"', () => {
    const dir = tmp('java');
    const cfg = loadConfig(dir);
    assert.equal(resolveJava({ ...cfg, java: 'C:/custom/java.exe' }), 'C:/custom/java.exe');
    const saved = process.env.JAVA_HOME;
    try {
      const exe = process.platform === 'win32' ? 'java.exe' : 'java';
      mkdirSync(join(dir, 'home', 'bin'), { recursive: true });
      writeFileSync(join(dir, 'home', 'bin', exe), 'x');
      process.env.JAVA_HOME = join(dir, 'home');
      assert.equal(resolveJava(cfg), join(dir, 'home', 'bin', exe));
      process.env.JAVA_HOME = join(dir, 'missing');
      assert.equal(resolveJava(cfg), 'java');
    } finally {
      if (saved === undefined) delete process.env.JAVA_HOME;
      else process.env.JAVA_HOME = saved;
    }
  });
});
