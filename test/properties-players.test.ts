import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PlayerTracker, readList } from '../src/players';
import { metaFor, PROP_META, Properties } from '../src/properties';
import type { ServerProcess } from '../src/server';
import { tmp } from './helpers';

describe('Properties', () => {
  const sample = ['#Minecraft server properties', '#Mon Oct 19', 'motd=A Minecraft Server', 'pvp=true', '', 'max-players=20', 'custom-key=a=b=c'].join('\n');

  it('reads entries and ignores comments and blank lines', () => {
    const dir = tmp('props');
    writeFileSync(join(dir, 'server.properties'), sample);
    const p = new Properties(dir);
    assert.equal(p.exists, true);
    assert.deepEqual(p.entries().map((e) => e.key), ['motd', 'pvp', 'max-players', 'custom-key']);
    assert.equal(p.get('motd'), 'A Minecraft Server');
    assert.equal(p.get('custom-key'), 'a=b=c');
    assert.equal(p.get('nope'), undefined);
  });

  it('handles Windows line endings', () => {
    const dir = tmp('props');
    writeFileSync(join(dir, 'server.properties'), sample.replace(/\n/g, '\r\n') + '\r\n');
    assert.equal(new Properties(dir).get('pvp'), 'true');
  });

  it('set() changes one value and keeps comments, order and unknown keys', () => {
    const dir = tmp('props');
    writeFileSync(join(dir, 'server.properties'), sample);
    const p = new Properties(dir);
    p.set('pvp', 'false');
    p.set('brand-new', '1');
    const text = readFileSync(join(dir, 'server.properties'), 'utf8');
    assert.match(text, /^#Minecraft server properties\n#Mon Oct 19\nmotd=A Minecraft Server\npvp=false\n\nmax-players=20\ncustom-key=a=b=c\nbrand-new=1\n$/);
  });

  it('copes with a missing file and creates it on first set', () => {
    const dir = tmp('props');
    const p = new Properties(dir);
    assert.equal(p.exists, false);
    assert.deepEqual(p.entries(), []);
    p.set('motd', 'hi');
    assert.equal(p.exists, true);
    assert.equal(new Properties(dir).get('motd'), 'hi');
  });

  it('reload() picks up outside changes', () => {
    const dir = tmp('props');
    writeFileSync(join(dir, 'server.properties'), 'a=1\n');
    const p = new Properties(dir);
    writeFileSync(join(dir, 'server.properties'), 'a=2\n');
    p.reload();
    assert.equal(p.get('a'), '2');
  });

  it('knows the common keys and guesses types for unknown ones', () => {
    assert.equal(metaFor('difficulty', 'easy').type, 'enum');
    assert.deepEqual(metaFor('difficulty', 'easy').options, ['peaceful', 'easy', 'normal', 'hard']);
    assert.equal(metaFor('pvp', 'true').type, 'bool');
    assert.equal(metaFor('weird-flag', 'false').type, 'bool');
    assert.equal(metaFor('weird-text', 'abc').type, 'string');
    assert.ok(Object.values(PROP_META).every((m) => m.desc.length > 5));
  });
});

describe('PlayerTracker', () => {
  function setup() {
    const server = new EventEmitter();
    const tracker = new PlayerTracker(server as unknown as ServerProcess);
    const changes: number[] = [];
    tracker.on('change', () => changes.push(tracker.online.size));
    return { server, tracker, changes };
  }

  it('tracks joins and leaves from the log', () => {
    const { server, tracker, changes } = setup();
    server.emit('line', '[12:00:00] [Server thread/INFO]: Steve joined the game');
    server.emit('line', '[12:00:01] [Server thread/INFO]: Alex joined the game');
    server.emit('line', '[12:00:02] [Server thread/INFO]: Steve left the game');
    assert.deepEqual([...tracker.online.keys()], ['Alex']);
    assert.deepEqual(changes, [1, 2, 1]);
  });

  it('syncs from a list response (new and old format) and learns the maximum', () => {
    const { server, tracker } = setup();
    server.emit('line', '[12:00:00] [Server thread/INFO]: Old joined the game');
    server.emit('line', '[12:00:05] [Server thread/INFO]: There are 2 of a max of 30 players online: Steve, Alex');
    assert.deepEqual([...tracker.online.keys()].sort(), ['Alex', 'Steve']);
    assert.equal(tracker.max, 30);
    server.emit('line', 'There are 1/20 players online: Alex');
    assert.deepEqual([...tracker.online.keys()], ['Alex']);
    assert.equal(tracker.max, 20);
    server.emit('line', '[x]: There are 0 of a max of 20 players online:');
    assert.equal(tracker.online.size, 0);
  });

  it('clears everyone when the server stops', () => {
    const { server, tracker, changes } = setup();
    server.emit('line', 'x: Steve joined the game');
    server.emit('state', 'stopped');
    assert.equal(tracker.online.size, 0);
    assert.equal(changes.at(-1), 0);
    server.emit('state', 'stopped'); // already empty: no extra event
    assert.equal(changes.length, 2);
  });

  it('ignores unrelated lines', () => {
    const { server, tracker, changes } = setup();
    server.emit('line', '<Steve> hello joined the game of life');
    assert.equal(tracker.online.size, 0);
    assert.equal(changes.length, 0);
  });
});

describe('readList', () => {
  it('reads whitelist, ops, bans and ip bans', () => {
    const dir = tmp('lists');
    writeFileSync(join(dir, 'whitelist.json'), JSON.stringify([{ uuid: '1', name: 'Steve' }]));
    writeFileSync(join(dir, 'ops.json'), JSON.stringify([{ uuid: '1', name: 'Steve', level: 4 }]));
    writeFileSync(join(dir, 'banned-players.json'), JSON.stringify([{ name: 'Bad', reason: 'griefing', source: 'Console' }, { name: 'Quiet' }]));
    writeFileSync(join(dir, 'banned-ips.json'), JSON.stringify([{ ip: '1.2.3.4', reason: 'spam' }]));
    assert.deepEqual(readList(dir, 'whitelist'), [{ name: 'Steve', detail: '' }]);
    assert.deepEqual(readList(dir, 'ops'), [{ name: 'Steve', detail: 'level 4' }]);
    assert.deepEqual(readList(dir, 'banned-players'), [
      { name: 'Bad', detail: 'griefing - by Console' },
      { name: 'Quiet', detail: '' },
    ]);
    assert.deepEqual(readList(dir, 'banned-ips'), [{ name: '1.2.3.4', detail: 'spam' }]);
  });

  it('returns an empty list for missing or invalid files', () => {
    const dir = tmp('lists');
    assert.deepEqual(readList(dir, 'ops'), []);
    writeFileSync(join(dir, 'ops.json'), 'not json');
    assert.deepEqual(readList(dir, 'ops'), []);
  });
});
