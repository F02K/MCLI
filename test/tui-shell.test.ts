import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { addFakeJava, customLaunch, fakeJavaVerify, K, makeJar, providerWorld, tmp, tuiRig, waitFor } from './helpers';
import { writeInstallMeta } from '../src/installmeta';

describe('TUI shell', () => {
  it('draws header, tabs, view and footer', async () => {
    const rig = await tuiRig(tmp('tui'));
    const s = rig.screen();
    assert.match(s.split('\n')[0], /MCLI dev\s+no server detected\s+○ STOPPED\s+0 players/);
    assert.match(s.split('\n')[1], /1 Dashboard.*2 Console.*3 Players.*4 Settings.*5 Versions.*6 Backups.*7 Help/);
    assert.match(s, /╭─ Server/);
    assert.match(s, /S start · X stop · R restart/);
    assert.match(s, /Tab switch · Ctrl\+C quit/);
    assert.equal(rig.term.cursor.visible, false, 'no text field on the dashboard');
  });

  it('switches views with Tab, Shift+Tab, F-keys, Alt+number and mouse clicks', async () => {
    const rig = await tuiRig(tmp('tui'));
    const title = () => rig.screen().split('\n')[2];
    await rig.press(K.tab);
    assert.match(rig.screen(), /❯ /, 'console has its input line');
    await rig.press(K.tab);
    assert.match(rig.screen(), /Online \(0\)/);
    await rig.press(K.shiftTab, K.shiftTab);
    assert.match(title(), /╭─ Server/);
    await rig.press(K.shiftTab);
    assert.match(rig.screen(), /Quick help|Navigation/, 'wraps around to Help');
    await rig.press(K.f(4));
    assert.match(rig.screen(), /server\.properties/);
    await rig.press(K.alt(6));
    assert.match(rig.screen(), /Backup settings/);
    await rig.press(K.f(5));
    assert.match(rig.screen(), /Installed server/);
    const tabsRow = rig.term.lines()[1];
    const x = tabsRow.indexOf('Players') + 2;
    await rig.press(K.click(x, 2));
    assert.match(rig.screen(), /Online \(0\)/);
    await rig.press(K.click(1, 2)); // padding before the first tab: nothing changes
    assert.match(rig.screen(), /Online \(0\)/);
  });

  it('shows a hint instead of the UI when the terminal is too small and recovers on resize', async () => {
    const rig = await tuiRig(tmp('tui'));
    rig.term.resize(60, 15);
    await rig.settle();
    assert.match(rig.screen(), /Terminal too small \(60x15\), need at least 70x18/);
    rig.term.resize(100, 30);
    await rig.settle();
    assert.match(rig.screen(), /╭─ Server/);
  });

  it('shows state, players and uptime in the header while a server runs', async () => {
    const dir = tmp('tui');
    const rig = await tuiRig(dir, customLaunch(dir));
    await rig.press('s');
    await waitFor(() => rig.core.server.state === 'running');
    rig.core.exec('join Steve');
    await waitFor(() => rig.core.players.online.size === 1);
    await rig.settle();
    assert.match(rig.screen().split('\n')[0], /● RUNNING\s+1 players · up/);
    assert.match(rig.screen().split('\n')[1], /3 Players 1/, 'badge on the Players tab');
  });

  it('closes the terminal when the program asks to exit', async () => {
    const rig = await tuiRig(tmp('tui'));
    rig.tui.close();
    assert.equal(rig.term.closed, true);
    rig.tui.close(); // idempotent
  });
});

describe('TUI quit flow', () => {
  it('Ctrl+C quits straight away when the server is stopped', async () => {
    const rig = await tuiRig(tmp('tui'));
    await rig.press(K.ctrl('c'));
    await waitFor(() => rig.exits.length > 0);
    assert.deepEqual(rig.exits, [0]);
  });

  it('asks before stopping a running server; N keeps everything running', async () => {
    const dir = tmp('tui');
    const rig = await tuiRig(dir, customLaunch(dir));
    await rig.press('s');
    await waitFor(() => rig.core.server.state === 'running');
    await rig.press(K.ctrl('c'));
    assert.match(rig.screen(), /Quit MCLI/);
    assert.match(rig.screen(), /The server is still running\./);
    await rig.press('n');
    assert.doesNotMatch(rig.screen(), /Quit MCLI/);
    assert.equal(rig.core.server.state, 'running');
    await rig.press('q'); // Q on a non-console view also asks
    assert.match(rig.screen(), /Quit MCLI/);
    await rig.press('y');
    await waitFor(() => rig.exits.length > 0);
    assert.deepEqual(rig.exits, [0]);
    assert.equal(rig.core.server.state, 'stopped');
  });

  it('mentions online players in the quit question and shows the stopping banner', async () => {
    const dir = tmp('tui');
    const slow = customLaunch(dir, 'console.log("Done (0.1s)! For help"); process.stdin.on("data", () => {}); setInterval(() => {}, 1000);');
    const rig = await tuiRig(dir, slow, { stopTimeoutMs: 600 });
    await rig.press('s');
    await waitFor(() => rig.core.server.state === 'running');
    rig.core.players.online.set('Steve', Date.now());
    await rig.press(K.ctrl('c'));
    assert.match(rig.screen(), /with 1 player\(s\) online/);
    await rig.press(K.enter);
    await rig.settle(80);
    assert.match(rig.screen(), /Stopping server before exit\.\.\. press Ctrl\+C to force quit/);
    await rig.press(K.ctrl('c')); // second request forces
    await waitFor(() => rig.exits.includes(1));
  });

  it('Q is just a letter inside the console input', async () => {
    const rig = await tuiRig(tmp('tui'));
    await rig.press(K.f(2));
    await rig.type('quit');
    assert.match(rig.screen(), /❯ quit/);
    assert.deepEqual(rig.exits, []);
  });
});

describe('TUI prompts', () => {
  it('pops up the EULA question when a start needs it, and Yes accepts and starts', async () => {
    const dir = tmp('tui');
    await makeJar(join(dir, 'minecraft_server.1.21.8.jar'), { main: 'net.minecraft.bundler.Main' });
    writeInstallMeta(dir, { provider: 'vanilla', mcVersion: '1.21.8', identity: '1.21.8', file: 'minecraft_server.1.21.8.jar', javaMajor: 17, installedAt: 'x' });
    writeFileSync(join(dir, 'eula.txt'), 'eula=false\n');
    addFakeJava(dir, 17);
    const rig = await tuiRig(dir, {}, { javaVerify: fakeJavaVerify });
    await rig.press('s');
    await waitFor(() => /Accept the Minecraft EULA/.test(rig.screen()), 3000, 'EULA popup');
    assert.match(rig.screen(), /https:\/\/aka\.ms\/MinecraftEULA/);
    await rig.press('y');
    assert.match(readFileSync(join(dir, 'eula.txt'), 'utf8'), /eula=true/);
    assert.match(rig.screen(), /EULA accepted/);
    await waitFor(() => rig.core.server.state !== 'stopped' || /Starting:/.test(rig.core.logs.map((l) => l.text).join()), 3000, 'start after accepting');
  });

  it('declining the EULA keeps the problem visible with its fix key', async () => {
    const dir = tmp('tui');
    await makeJar(join(dir, 'minecraft_server.1.21.8.jar'), { main: 'net.minecraft.bundler.Main' });
    writeFileSync(join(dir, 'eula.txt'), 'eula=false\n');
    addFakeJava(dir, 21);
    const rig = await tuiRig(dir, {}, { javaVerify: fakeJavaVerify });
    await rig.press('s');
    await waitFor(() => /Accept the Minecraft EULA/.test(rig.screen()));
    await rig.press('n');
    assert.match(rig.screen(), /Problems \(1\)/);
    assert.match(rig.screen(), /✗ The Minecraft EULA is not accepted\s+\[E = accept EULA\]/);
    assert.match(rig.screen().split('\n')[1], /Dashboard !1/);
    await rig.press('e');
    assert.match(rig.screen(), /Accept the Minecraft EULA/);
    await rig.press(K.esc);
  });

  it('offers to install a missing Java and downloads it after Yes', async () => {
    const world = await providerWorld();
    const dir = tmp('tui');
    await makeJar(join(dir, 'minecraft_server.1.21.8.jar'), { main: 'net.minecraft.bundler.Main' });
    writeInstallMeta(dir, { provider: 'vanilla', mcVersion: '1.21.8', identity: '1.21.8', file: 'minecraft_server.1.21.8.jar', javaMajor: 99, installedAt: 'x' });
    const rig = await tuiRig(dir, {}, { javaVerify: fakeJavaVerify, javaApi: world.javaApi });
    await rig.press('s');
    await waitFor(() => /Install Java 99/.test(rig.screen()), 4000, 'java popup');
    assert.match(rig.screen(), /OpenJDK99U-jre/);
    assert.match(rig.screen(), /SHA-256 is verified/);
    await rig.press('y');
    await waitFor(() => rig.core.java.installs.some((j) => j.major === 99), 6000, 'java installed');
    await rig.settle(50);
    assert.match(rig.screen(), /Java 99 installed\./);
  });

  it('J on the dashboard offers the missing Java; without a problem it opens Versions', async () => {
    const world = await providerWorld();
    const dir = tmp('tui');
    await makeJar(join(dir, 'minecraft_server.1.21.8.jar'), { main: 'net.minecraft.bundler.Main' });
    writeInstallMeta(dir, { provider: 'vanilla', mcVersion: '1.21.8', identity: '1.21.8', file: 'minecraft_server.1.21.8.jar', javaMajor: 99, installedAt: 'x' });
    const rig = await tuiRig(dir, {}, { javaVerify: fakeJavaVerify, javaApi: world.javaApi });
    await rig.press('j');
    assert.match(rig.screen(), /Installed server/, 'no problem yet: goes to Versions');
    await rig.press(K.f(1), 's');
    await waitFor(() => /Install Java 99/.test(rig.screen()), 4000);
    await rig.press('n');
    assert.match(rig.screen(), /\[J = install Java 99\]/);
    await rig.press('j');
    await waitFor(() => /Install Java 99/.test(rig.screen()), 4000);
    await rig.press(K.esc);
  });

  it('a Java prompt for an unknown version reports the lookup failure', async () => {
    const world = await providerWorld();
    const rig = await tuiRig(tmp('tui'), {}, { javaVerify: fakeJavaVerify, javaApi: world.javaApi });
    rig.tui.javaPrompt(98);
    await waitFor(() => /Could not look up Java 98/.test(rig.screen()), 3000);
  });
});
