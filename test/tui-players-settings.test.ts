import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { customLaunch, K, tmp, tuiRig, waitFor, type Rig } from './helpers';

function lists(dir: string): void {
  writeFileSync(join(dir, 'whitelist.json'), JSON.stringify([{ uuid: '1', name: 'Steve' }, { uuid: '2', name: 'Alex' }]));
  writeFileSync(join(dir, 'ops.json'), JSON.stringify([{ uuid: '1', name: 'Steve', level: 4 }]));
  writeFileSync(join(dir, 'banned-players.json'), JSON.stringify([{ name: 'Griefer', reason: 'griefing', source: 'Console' }]));
  writeFileSync(join(dir, 'banned-ips.json'), JSON.stringify([{ ip: '1.2.3.4', reason: 'spam' }]));
  writeFileSync(join(dir, 'server.properties'), 'white-list=false\n');
}

async function playersRig(withServer = true): Promise<Rig> {
  const dir = tmp('tui');
  lists(dir);
  const rig = await tuiRig(dir, withServer ? customLaunch(dir) : {});
  if (withServer) {
    await rig.press('s');
    await waitFor(() => rig.core.server.state === 'running');
    rig.core.exec('join Steve');
    rig.core.exec('join Alex');
    await waitFor(() => rig.core.players.online.size === 2);
  }
  await rig.press(K.f(3));
  return rig;
}

const ran = (rig: Rig, re: RegExp) => waitFor(() => rig.core.logs.some((l) => l.src === 'server' && re.test(l.text)), 3000, String(re));

describe('Players view', () => {
  it('lists online players and the file based lists with their counts', async () => {
    const rig = await playersRig();
    const s = rig.screen();
    assert.match(s, /Online \(2\)\s+Whitelist \(2\)\s+Operators \(1\)\s+Bans \(1\)\s+IP bans \(1\)/);
    assert.match(s, /Steve\s+\d+s/);
    assert.match(s, /Alex/);
    await rig.press(K.right);
    assert.match(rig.screen(), /╭─ Whitelist .* whitelist is OFF/);
    await rig.press(K.right);
    assert.match(rig.screen(), /Steve\s+level 4/);
    await rig.press(K.right);
    assert.match(rig.screen(), /Griefer\s+griefing - by Console/);
    await rig.press(K.right);
    assert.match(rig.screen(), /1\.2\.3\.4\s+spam/);
    await rig.press(K.right);
    assert.match(rig.screen(), /Online players/, 'wraps around');
    await rig.press(K.left);
    assert.match(rig.screen(), /1\.2\.3\.4/);
  });

  it('runs player actions from the keyboard (kick with reason, ban, op, deop, whitelist, message)', async () => {
    const rig = await playersRig();
    await rig.press('k');
    assert.match(rig.screen(), /Kick Steve/);
    await rig.type('afk');
    await rig.press(K.enter);
    await ran(rig, /ran: kick Steve afk/);
    assert.match(rig.screen(), /Kicked Steve/);
    await rig.press(K.down, 'b');
    await rig.type('cheating');
    await rig.press(K.enter);
    await ran(rig, /ran: ban Alex cheating/);
    for (const [key, cmd] of [['o', 'op Alex'], ['d', 'deop Alex'], ['w', 'whitelist add Alex']] as const) {
      await rig.press(key);
      await ran(rig, new RegExp(`ran: ${cmd}`));
    }
    await rig.press('m');
    await rig.type('hello there');
    await rig.press(K.enter);
    await ran(rig, /ran: msg Alex hello there/);
  });

  it('opens an action menu with Enter', async () => {
    const rig = await playersRig();
    await rig.press(K.enter);
    assert.match(rig.screen(), /Player Steve/);
    assert.match(rig.screen(), /Kick\n|Kick\s/);
    await rig.press(K.down, K.down, K.enter); // Op
    await ran(rig, /ran: op Steve/);
    await rig.press(K.enter, K.down, K.down, K.down, K.down, K.enter); // Add to whitelist
    await ran(rig, /ran: whitelist add Steve/);
  });

  it('adds and removes list entries, validating the input', async () => {
    const rig = await playersRig();
    await rig.press(K.right, 'a'); // whitelist
    assert.match(rig.screen(), /Whitelist player/);
    await rig.type('bad name!');
    await rig.press(K.enter);
    assert.match(rig.screen(), /Enter a valid player name/);
    for (let i = 0; i < 9; i++) await rig.press(K.bs);
    await rig.type('Newbie');
    await rig.press(K.enter);
    await ran(rig, /ran: whitelist add Newbie/);

    await rig.press('x');
    assert.match(rig.screen(), /Remove "Steve"\?/);
    await rig.press('y');
    await ran(rig, /ran: whitelist remove Steve/);
    await rig.press(K.del);
    assert.match(rig.screen(), /Remove "Steve"\?/);
    await rig.press('n');

    await rig.press(K.right, 'a'); // ops
    await rig.type('Alex');
    await rig.press(K.enter);
    await ran(rig, /ran: op Alex/);
    await rig.press('x', 'y');
    await ran(rig, /ran: deop Steve/);

    await rig.press(K.right, 'a'); // bans
    await rig.type('Cheater');
    await rig.press(K.enter);
    assert.match(rig.screen(), /Ban Cheater/);
    await rig.type('hacks');
    await rig.press(K.enter);
    await ran(rig, /ran: ban Cheater hacks/);
    await rig.press('x', 'y');
    await ran(rig, /ran: pardon Griefer/);

    await rig.press(K.right, 'a'); // ip bans
    await rig.type('not-an-ip!');
    await rig.press(K.enter);
    assert.match(rig.screen(), /Enter a valid IP address/);
    for (let i = 0; i < 10; i++) await rig.press(K.bs);
    await rig.type('5.6.7.8');
    await rig.press(K.enter);
    await ran(rig, /ran: ban-ip 5\.6\.7\.8/);
    await rig.press('x', 'y');
    await ran(rig, /ran: pardon-ip 1\.2\.3\.4/);
  });

  it('toggles the whitelist', async () => {
    const rig = await playersRig();
    await rig.press(K.right, 't');
    await ran(rig, /ran: whitelist on/);
    writeFileSync(join(rig.core.cfg.serverDir, 'server.properties'), 'white-list=true\n');
    await rig.press('t');
    await ran(rig, /ran: whitelist off/);
  });

  it('explains that actions need a running server and that lists are read-only meanwhile', async () => {
    const rig = await playersRig(false);
    assert.match(rig.screen(), /Server is stopped - nobody is online/);
    await rig.press(K.right);
    assert.match(rig.screen(), /read-only while stopped/);
    await rig.press('a');
    await rig.type('Someone');
    await rig.press(K.enter);
    assert.match(rig.screen(), /The server must be running for this action/);
    await rig.press(K.right, K.right, K.right, K.right);
    assert.match(rig.screen(), /Online players/);
    await rig.press('k'); // nobody selected: ignored
    await rig.press('t'); // not on the whitelist tab
  });

  it('shows an empty-list hint and handles unknown keys', async () => {
    const dir = tmp('tui');
    const rig = await tuiRig(dir);
    await rig.press(K.f(3), K.right);
    assert.match(rig.screen(), /Nothing here yet\. Press A to add an entry\./);
    await rig.press('x', 'z', K.enter, K.down, K.up, K.pgdn, K.pgup, K.home, K.end);
  });

  it('works with the mouse: tab titles, rows and the wheel', async () => {
    const rig = await playersRig();
    const tabs = rig.term.lines()[2];
    await rig.press(K.click(tabs.indexOf('Whitelist') + 2, 3));
    assert.match(rig.screen(), /╭─ Whitelist/);
    await rig.press(K.click(5, 7)); // second row of the table
    await rig.press('x');
    assert.match(rig.screen(), /Remove "Alex"\?/);
    await rig.press(K.esc);
    await rig.press(K.wheelUp); // wheel moves the selection back up
    await rig.press('x');
    assert.match(rig.screen(), /Remove "Steve"\?/);
    await rig.press(K.esc, K.wheelDown);
  });
});

describe('Settings view', () => {
  async function settingsRig(extra = ''): Promise<{ rig: Rig; dir: string }> {
    const dir = tmp('tui');
    writeFileSync(join(dir, 'server.properties'), ['#comment', 'difficulty=easy', 'pvp=true', 'max-players=20', 'motd=A Minecraft Server', 'view-distance=10', 'custom-flag=false', extra].join('\n'));
    const rig = await tuiRig(dir);
    await rig.press(K.f(4));
    return { rig, dir };
  }
  const file = (dir: string) => readFileSync(join(dir, 'server.properties'), 'utf8');

  it('lists the keys with typed values and shows details of the selection', async () => {
    const { rig } = await settingsRig();
    const s = rig.screen();
    assert.match(s, /difficulty\s+easy/);
    assert.match(s, /pvp\s+● true/);
    assert.match(s, /custom-flag\s+○ false/);
    assert.match(s, /1\/6/);
    assert.match(s, /difficulty {2}\(enum: peaceful \/ easy \/ normal \/ hard\)/);
    assert.match(s, /Game difficulty\./);
  });

  it('toggles booleans, picks enum values and edits numbers and text', async () => {
    const { rig, dir } = await settingsRig();
    await rig.press(K.enter); // difficulty -> menu
    assert.match(rig.screen(), /easy\s+\(current\)/);
    await rig.press(K.down, K.down, K.enter); // hard
    assert.match(file(dir), /difficulty=hard/);
    assert.match(rig.screen(), /Saved difficulty = hard/);

    await rig.press(K.down, ' '); // pvp
    assert.match(file(dir), /pvp=false/);

    await rig.press(K.down, K.enter); // max-players
    await rig.type('abc');
    await rig.press(K.enter);
    assert.match(rig.screen(), /Enter a whole number/);
    for (let i = 0; i < 6; i++) await rig.press(K.bs);
    await rig.type('42');
    await rig.press(K.enter);
    assert.match(file(dir), /max-players=42/);

    await rig.press(K.down, K.enter); // motd
    for (let i = 0; i < 30; i++) await rig.press(K.bs);
    await rig.type('Hello World');
    await rig.press(K.enter);
    assert.match(file(dir), /motd=Hello World/);
    assert.match(file(dir), /^#comment/, 'comments survive');
  });

  it('warns that changes need a restart while the server runs', async () => {
    const dir = tmp('tui');
    writeFileSync(join(dir, 'server.properties'), 'pvp=true\n');
    const rig = await tuiRig(dir, customLaunch(dir));
    await rig.press('s');
    await waitFor(() => rig.core.server.state === 'running');
    await rig.press(K.f(4), K.enter);
    assert.match(rig.screen(), /applies after a server restart/);
    assert.match(rig.screen(), /The server is running: changes apply after a restart/);
  });

  it('filters keys with "/" and clears the filter with Esc', async () => {
    const { rig } = await settingsRig();
    await rig.press('/');
    await rig.type('dist');
    await rig.press(K.enter);
    assert.match(rig.screen(), /filter "dist"/);
    assert.match(rig.screen(), /view-distance/);
    assert.doesNotMatch(rig.screen(), /difficulty\s+easy/);
    await rig.press(K.esc);
    assert.match(rig.screen(), /difficulty\s+easy/);
    await rig.press('/');
    await rig.type('nothing-matches');
    await rig.press(K.enter);
    assert.match(rig.screen(), /No settings match the filter/);
    await rig.press(K.enter); // nothing selected: no crash
  });

  it('reloads from disk with R', async () => {
    const { rig, dir } = await settingsRig();
    writeFileSync(join(dir, 'server.properties'), 'pvp=false\n');
    await rig.press('r');
    assert.match(rig.screen(), /Reloaded settings from disk/);
    assert.match(rig.screen(), /pvp\s+○ false/);
  });

  it('explains a missing server.properties', async () => {
    const dir = tmp('tui');
    const rig = await tuiRig(dir);
    await rig.press(K.f(4));
    assert.match(rig.screen(), /server\.properties not found\./);
  });

  it('edits MCLI settings and writes mcli.json', async () => {
    const { rig, dir } = await settingsRig();
    await rig.press(K.right);
    assert.match(rig.screen(), /MCLI settings \(mcli\.json\)/);
    assert.match(rig.screen(), /minMemory\s+1G/);
    const cfg = () => JSON.parse(readFileSync(join(dir, 'mcli.json'), 'utf8')) as Record<string, unknown>;

    await rig.press(K.down, K.down, K.down, K.enter); // maxMemory? rows: java, javaAutoInstall, minMemory, maxMemory...
    for (let i = 0; i < 5; i++) await rig.press(K.bs);
    await rig.type('2X');
    await rig.press(K.enter);
    assert.match(rig.screen(), /Use a number with K, M or G/);
    await rig.press(K.bs, K.bs);
    await rig.type('6G');
    await rig.press(K.enter);
    assert.equal(cfg().maxMemory, '6G');

    await rig.press(K.up, K.up, ' '); // javaAutoInstall (bool)
    assert.equal(cfg().javaAutoInstall, true);
    await rig.press(K.down, K.down, K.down, ' '); // autoRestart
    assert.equal(cfg().autoRestart, false);

    await rig.press(K.down, K.enter); // maxRestarts
    for (let i = 0; i < 3; i++) await rig.press(K.bs);
    await rig.type('-5');
    await rig.press(K.enter);
    assert.match(rig.screen(), /Must be 0 or greater/);
    await rig.press(K.bs, K.bs);
    await rig.type('5');
    await rig.press(K.enter);
    assert.equal(cfg().maxRestarts, 5);

    await rig.press(K.up, K.up, K.up, K.up, K.up, K.enter); // java (string, empty is fine)
    await rig.type('C:/jdk/bin/java.exe');
    await rig.press(K.enter);
    assert.equal(cfg().java, 'C:/jdk/bin/java.exe');
    await rig.press(K.left);
    assert.match(rig.screen(), /server\.properties/);
  });

  it('works with the mouse: sections and rows', async () => {
    const { rig } = await settingsRig();
    const tabs = rig.term.lines()[2];
    await rig.press(K.click(tabs.indexOf('MCLI') + 2, 3));
    assert.match(rig.screen(), /MCLI settings \(mcli\.json\)/);
    await rig.press(K.click(3, 3));
    await rig.press(K.click(5, 7));
    await rig.press(K.wheelDown, K.wheelUp);
    await rig.press(K.click(3, 3));
    assert.match(rig.screen(), /server\.properties/);
  });

  it('survives unwritable settings with an error toast', async () => {
    const { rig, dir } = await settingsRig();
    mkdirSync(join(dir, 'blocked'));
    rig.core.cfg.configDir = join(dir, 'blocked', 'does', 'not', 'exist');
    await rig.press(K.right, K.down, ' '); // javaAutoInstall -> cannot write mcli.json
    assert.match(rig.screen(), /Could not save/);
  });
});
