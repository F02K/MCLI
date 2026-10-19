import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { customLaunch, K, tmp, tuiRig, waitFor, type Rig } from './helpers';

async function running(cfg: Record<string, unknown> = {}, size?: [number, number]): Promise<Rig> {
  const dir = tmp('tui');
  const rig = await tuiRig(dir, { ...customLaunch(dir), ...cfg }, {}, size);
  await rig.press('s');
  await waitFor(() => rig.core.server.state === 'running');
  return rig;
}

describe('Console view', () => {
  it('sends typed text to the server and echoes it', async () => {
    const rig = await running();
    await rig.press(K.f(2));
    await rig.type('join Steve');
    assert.match(rig.screen(), /❯ join Steve/);
    assert.equal(rig.term.cursor.visible, true);
    await rig.press(K.enter);
    await waitFor(() => rig.core.players.online.has('Steve'));
    await rig.settle();
    assert.match(rig.screen(), /› join Steve/);
    assert.match(rig.screen(), /Steve joined the game/);
    assert.doesNotMatch(rig.screen(), /❯ join/, 'input is cleared');
  });

  it('runs MCLI commands, ignores empty input and shows a hint while stopped', async () => {
    const rig = await tuiRig(tmp('tui'));
    await rig.press(K.f(2));
    assert.match(rig.screen(), /server stopped - type :start/);
    await rig.press(K.enter);
    await rig.type(':help');
    await rig.press(K.enter);
    assert.match(rig.screen(), /MCLI commands/);
    await rig.type('hello');
    await rig.press(K.enter);
    assert.match(rig.screen(), /Server is not running/);
  });

  it('keeps a command history that Up/Down browse', async () => {
    const rig = await tuiRig(tmp('tui'));
    await rig.press(K.f(2), K.down, K.up); // empty history: nothing happens
    for (const cmd of [':status', ':status', ':help']) {
      await rig.type(cmd);
      await rig.press(K.enter);
    }
    await rig.press(K.up);
    assert.match(rig.screen(), /❯ :help/);
    await rig.press(K.up);
    assert.match(rig.screen(), /❯ :status/);
    await rig.press(K.up, K.up);
    assert.match(rig.screen(), /❯ :status/, 'stops at the oldest entry (duplicates are stored once)');
    await rig.press(K.down);
    assert.match(rig.screen(), /❯ :help/);
    await rig.press(K.down);
    assert.doesNotMatch(rig.screen(), /❯ :/, 'back to an empty line');
  });

  it('edits the line (cursor keys, delete, backspace)', async () => {
    const rig = await tuiRig(tmp('tui'));
    await rig.press(K.f(2));
    await rig.type('helo');
    await rig.press(K.left, 'l', K.home, K.del);
    assert.match(rig.screen(), /❯ ello/);
    await rig.press(K.end, K.bs);
    assert.match(rig.screen(), /❯ ell$/m);
  });

  it('filters the log with Ctrl+F and clears the filter with Esc', async () => {
    const rig = await running();
    rig.core.exec('join Alexander');
    rig.core.exec('join Beatrice');
    await waitFor(() => rig.core.players.online.size === 2);
    await rig.press(K.f(2));
    assert.match(rig.screen(), /Alexander joined/);
    await rig.press(K.ctrl('f'));
    assert.match(rig.screen(), /Filter console/);
    await rig.type('Beatrice');
    await rig.press(K.enter);
    assert.doesNotMatch(rig.screen(), /Alexander joined/);
    assert.match(rig.screen(), /Beatrice joined/);
    assert.match(rig.screen(), /filter: "Beatrice"/);
    await rig.press(K.esc);
    assert.match(rig.screen(), /Alexander joined/);
    assert.doesNotMatch(rig.screen(), /filter:/);
  });

  it('scrolls with PgUp/PgDn/mouse wheel, counts new lines while scrolled and jumps back with Ctrl+L', async () => {
    const rig = await running();
    for (let i = 0; i < 80; i++) rig.core.addLog(`filler line ${i}`, 'server');
    await rig.press(K.f(2));
    assert.match(rig.screen(), /filler line 79/);
    await rig.press(K.pgup);
    assert.match(rig.screen(), /↑ 10 rows up/);
    assert.doesNotMatch(rig.screen(), /filler line 79/);
    rig.core.addLog('fresh line while reading', 'server');
    await rig.settle();
    assert.match(rig.screen(), /1 new/);
    await rig.press(K.wheelUp);
    assert.match(rig.screen(), /↑ 14 rows up/);
    await rig.press(K.wheelDown, K.pgdn);
    assert.match(rig.screen(), /↑ 1 rows up|↑ 11 rows up/);
    await rig.press(K.ctrl('l'));
    assert.match(rig.screen(), /fresh line while reading/);
    assert.doesNotMatch(rig.screen(), /rows up/);
    await rig.press(K.pgup, K.pgup, K.pgdn, K.pgdn, K.pgdn);
    assert.doesNotMatch(rig.screen(), /rows up/);
  });

  it('wraps long lines and strips terminal escape codes from server output', async () => {
    const rig = await running();
    rig.core.addLog('x'.repeat(250), 'server');
    rig.core.addLog('\x1b[31mred\x1b[0m\ttabbed\x07', 'server');
    await rig.press(K.f(2));
    const long = rig.term.lines().filter((l) => /^x+$/.test(l));
    assert.deepEqual(long.map((l) => l.length), [120, 120, 10]);
    assert.match(rig.screen(), /red {4}tabbed/);
  });

  it('shows server problems and joins/leaves in the log without breaking', async () => {
    const rig = await running();
    for (const line of ['[12:00:00] [Server thread/ERROR]: boom', '[12:00:00] [Server thread/WARN]: careful', '\tat java.base/Foo.bar(Foo.java:1)', '<Steve> hello everyone', 'Steve left the game', 'plain']) {
      rig.core.addLog(line, 'server');
    }
    await rig.press(K.f(2));
    for (const text of ['boom', 'careful', 'hello everyone', 'Steve left the game', 'plain']) assert.match(rig.screen(), new RegExp(text));
  });

  it('scrolls past the top of the log without errors', async () => {
    const rig = await tuiRig(tmp('tui'));
    await rig.press(K.f(2));
    for (let i = 0; i < 20; i++) await rig.press(K.pgup);
    assert.match(rig.screen(), /❯ /);
  });
});

describe('Dashboard view', () => {
  it('start/stop/restart/backup/console buttons work from the keyboard', async () => {
    const dir = tmp('tui');
    const rig = await tuiRig(dir, customLaunch(dir));
    assert.match(rig.screen(), /S {2}Start .*X {2}Stop .*R {2}Restart .*B {2}Backup .*C {2}Console/);
    await rig.press('x');
    assert.match(rig.screen(), /"Stop" is not available right now \(server is stopped\)/);
    await rig.press('s');
    await waitFor(() => rig.core.server.state === 'running');
    await rig.press('s');
    assert.match(rig.screen(), /"Start" is not available/);
    await rig.press('b');
    await rig.press('c');
    assert.match(rig.screen(), /❯/);
    await rig.press(K.f(1), 'r');
    await waitFor(() => rig.core.server.state === 'stopping' || rig.core.server.state === 'starting', 3000);
    await waitFor(() => rig.core.server.state === 'running', 8000);
    await rig.press('x');
    await waitFor(() => rig.core.server.state === 'stopped');
  });

  it('asks before stopping or restarting when players are online', async () => {
    const rig = await running();
    rig.core.exec('join Steve');
    await waitFor(() => rig.core.players.online.size === 1);
    await rig.press('x');
    assert.match(rig.screen(), /Stop the server\?/);
    assert.match(rig.screen(), /1 player\(s\) are online/);
    await rig.press('n');
    assert.equal(rig.core.server.state, 'running');
    await rig.press('r');
    assert.match(rig.screen(), /Restart the server\?/);
    await rig.press(K.esc);
    await rig.press('x', 'y');
    await waitFor(() => rig.core.server.state === 'stopped');
  });

  it('buttons react to mouse clicks', async () => {
    const dir = tmp('tui');
    const rig = await tuiRig(dir, customLaunch(dir));
    const row = rig.term.lines().findIndex((l) => /S {2}Start/.test(l));
    const x = rig.term.lines()[row].indexOf('Start') + 1;
    await rig.press(K.click(x, row + 1));
    await waitFor(() => rig.core.server.state !== 'stopped');
    await waitFor(() => rig.core.server.state === 'running');
    await rig.press(K.click(1, 5)); // not a button
    await rig.press('\x1b[<2;5;5M'); // right button
    await rig.press('\x1b[<0;5;5m'); // release
    assert.equal(rig.core.server.state, 'running');
  });

  it('shows what is going on: health, uptime, players, resources and recent log', async () => {
    const rig = await running();
    rig.core.health = { reachable: true, everReachable: true, failures: 0, port: 25565, latencyMs: 4, version: '1.21.8' };
    rig.core.players.online.set('Steve', Date.now());
    rig.core.players.max = 20;
    await rig.metrics();
    await rig.refresh();
    const s = rig.screen();
    assert.match(s, /Status {3}● RUNNING/);
    assert.match(s, /Health {3}✓ answers on :25565 · 4 ms · 1\.21\.8/);
    assert.match(s, /Players {2}1 \/ 20/);
    assert.match(s, /● Steve/);
    assert.match(s, /System CPU/);
    assert.match(s, /Server RAM/);
    assert.match(s, /Recent log/);
  });

  it('describes the health of a server that does not answer', async () => {
    const rig = await running();
    rig.core.health = { reachable: false, everReachable: true, failures: 3 };
    await rig.refresh();
    assert.match(rig.screen(), /✗ not answering for 15s/);
    rig.core.health = { reachable: false, everReachable: false, failures: 3 };
    await rig.refresh();
    assert.match(rig.screen(), /no status reply/);
  });

  it('describes update states', async () => {
    const rig = await tuiRig(tmp('tui'));
    const check = async (info: object | null, re: RegExp) => {
      rig.core.updateInfo = info as never;
      await rig.refresh();
      assert.match(rig.screen(), re);
    };
    await check(null, /Updates {2}checking/);
    await check({ checkedAt: 1, error: 'offline' }, /check failed/);
    await check({ checkedAt: 1, sameMc: { display: 'Paper 1.21.8 build 62' } }, /⬆ Paper 1\.21\.8 build 62/);
    await check({ checkedAt: 1, newerMc: '26.3' }, /build current · newer Minecraft: 26\.3/);
    await check({ checkedAt: 1, unknown: true }, /not tracked/);
    await check({ checkedAt: 1 }, /✓ up to date/);
    rig.core.installer.busy = 'Downloading x - 5 MB';
    await check({ checkedAt: 1 }, /Downloading x/);
    rig.core.installer.busy = null;
    rig.core.java.busy = 'Downloading Java 21';
    await check({ checkedAt: 1 }, /Downloading Java 21/);
    rig.core.java.busy = null;
  });

  it('lists problems with their fix keys and the fix keys navigate', async () => {
    const rig = await tuiRig(tmp('tui'));
    rig.core.addProblem({ id: 'a', title: 'Needs settings', advice: 'Change a setting', fatal: true, action: 'settings' });
    rig.core.addProblem({ id: 'b', title: 'Needs versions', advice: 'Install it', fatal: true, action: 'versions' });
    rig.core.addProblem({ id: 'c', title: 'World broken', advice: 'Restore', fatal: false, action: 'backups' });
    rig.core.addProblem({ id: 'd', title: 'Plain info', advice: 'Nothing to press', fatal: false });
    await rig.settle(30);
    const s = rig.screen();
    assert.match(s, /Problems \(4\)/);
    assert.match(s, /\[G = open Settings\]/);
    assert.match(s, /\[V = open Versions\]/);
    assert.match(s, /\[K = open Backups\]/);
    assert.match(s.split('\n')[1], /Dashboard !4/);
    assert.match(s, /E\/V\/G\/J\/K fix problems/);
    await rig.press('g');
    assert.match(rig.screen(), /╭─ server\.properties|server\.properties/);
    await rig.press(K.f(1), 'v');
    assert.match(rig.screen(), /Installed server/);
    await rig.press(K.f(1), 'k');
    assert.match(rig.screen(), /Backup settings/);
    await rig.press(K.f(1), 'z'); // unknown key falls through
  });

  it('adapts to a narrow terminal and a short one', async () => {
    const rig = await running({}, [90, 40]);
    assert.match(rig.screen(), /╭─ Server/);
    assert.match(rig.screen(), /╭─ Resources/);
    rig.term.resize(90, 22);
    await rig.settle();
    assert.match(rig.screen(), /╭─ Server/);
    assert.doesNotMatch(rig.screen(), /╭─ Resources/, 'drops the resources box when there is no room');
    rig.term.resize(130, 20);
    await rig.settle();
    assert.match(rig.screen(), /S {2}Start/);
  });
});

describe('Help view', () => {
  it('lists the keys and scrolls', async () => {
    const rig = await tuiRig(tmp('tui'));
    await rig.press(K.f(7));
    assert.match(rig.screen(), /Navigation/);
    assert.match(rig.screen(), /Tab \/ Shift\+Tab/);
    await rig.press(K.pgdn);
    assert.doesNotMatch(rig.screen(), /Navigation/);
    await rig.press(K.end);
    assert.match(rig.screen(), /Backups:/);
    assert.match(rig.screen(), /Config file:/);
    await rig.press(K.home, K.down, K.up, K.pgup, K.wheelDown, K.wheelDown, K.wheelUp);
    assert.match(rig.screen(), /Help/);
    await rig.press('x'); // unknown key is ignored
  });
});
