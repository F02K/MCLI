import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { FAKE_SERVER, tmp } from './helpers';

const ENTRY = resolve(__dirname, '..', 'src', 'index.js');

/** Runs the real entry point in `cwd` without a terminal (plain mode) and feeds it `input`. */
function run(cwd: string, args: string[], input: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('exit', (code) => resolveRun({ code, out, err }));
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

describe('command line', () => {
  it('prints its version', async () => {
    const dir = tmp('cli');
    const a = await run(dir, ['--version'], '');
    assert.equal(a.code, 0);
    assert.match(a.out, /^MCLI dev\s*$/);
    assert.match((await run(dir, ['-v'], '')).out, /^MCLI dev/);
  });

  it('runs headless: banner, commands from stdin, clean exit at end of input', async () => {
    const dir = tmp('cli');
    const r = await run(dir, [], ':help\n:status\n:nonsense\nsay hi\n');
    assert.equal(r.code, 0);
    assert.match(r.out, /\[MCLI\] MCLI dev/);
    assert.match(r.out, /Server folder: /);
    assert.match(r.out, /MCLI commands/);
    assert.match(r.out, /no server detected \| state: stopped/);
    assert.match(r.out, /Unknown command "nonsense"/);
    assert.match(r.out, /Server is not running/);
  });

  it('starts a server, forwards console input and stops it on :quit', async () => {
    const dir = tmp('cli');
    writeFileSync(join(dir, 'fake.js'), FAKE_SERVER);
    writeFileSync(join(dir, 'mcli.json'), JSON.stringify({ customLaunch: { command: process.execPath, args: ['fake.js'] } }));
    const r = await new Promise<{ code: number | null; out: string }>((resolveRun) => {
      const child = spawn(process.execPath, [ENTRY], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (c: Buffer) => {
        out += c.toString();
        if (/Done \(0\.3s\)/.test(out) && !out.includes('› list')) child.stdin.write('list\n:quit\n');
      });
      child.on('exit', (code) => resolveRun({ code, out }));
      child.stdin.write(':start\n');
    });
    assert.equal(r.code, 0);
    assert.match(r.out, /Starting: .*fake\.js/);
    assert.match(r.out, /There are 0 of a max of 20 players online/);
    assert.match(r.out, /Stopping server before exit/);
    assert.match(r.out, /Server exited with code 0/);
  });

  it('reports a broken mcli.json and exits with an error', async () => {
    const dir = tmp('cli');
    writeFileSync(join(dir, 'mcli.json'), '{ broken');
    const r = await run(dir, [], '');
    assert.equal(r.code, 1);
    assert.match(r.err, /Cannot parse .*mcli\.json/);
  });
});
