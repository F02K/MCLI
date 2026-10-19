import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { tmp } from './helpers';

const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'next-version.mjs');

/** A throw-away git repository on which the real release script runs. */
function repo() {
  const dir = tmp('versioning');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  git('init', '-q', '.');
  const commit = (subject: string, body?: string) => git('commit', '-q', '--allow-empty', '-m', subject, ...(body ? ['-m', body] : []));
  const next = (...args: string[]): Record<string, string> => {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { cwd: dir }).toString();
    return Object.fromEntries(out.trim().split('\n').map((l) => l.split('=') as [string, string]));
  };
  return { dir, git, commit, next, tag: (t: string) => git('tag', t) };
}

describe('next-version script', () => {
  it('releases 0.1.0 when there is no tag yet', () => {
    const r = repo();
    r.commit('chore: init');
    assert.deepEqual(r.next(), { release: 'true', version: '0.1.0', tag: 'v0.1.0' });
  });

  it('does nothing when there are no new commits since the tag', () => {
    const r = repo();
    r.commit('feat: first');
    r.tag('v0.1.0');
    assert.equal(r.next().release, 'false');
  });

  it('does nothing for documentation and chores', () => {
    const r = repo();
    r.commit('feat: first');
    r.tag('v0.1.0');
    r.commit('docs: readme');
    r.commit('chore: deps');
    r.commit('ci: workflow');
    r.commit('test: more');
    assert.equal(r.next().release, 'false');
  });

  it('fix, perf and refactor make a patch release', () => {
    for (const type of ['fix', 'perf', 'refactor']) {
      const r = repo();
      r.commit('feat: first');
      r.tag('v0.1.0');
      r.commit(`${type}: something`);
      assert.equal(r.next().version, '0.1.1', type);
    }
  });

  it('feat makes a minor release and beats fix', () => {
    const r = repo();
    r.commit('feat: first');
    r.tag('v0.3.2');
    r.commit('fix: a');
    r.commit('feat(ui): b');
    assert.equal(r.next().version, '0.4.0');
  });

  it('breaking changes bump minor below 1.0 and major from 1.0', () => {
    const a = repo();
    a.commit('feat: first');
    a.tag('v0.2.0');
    a.commit('feat!: new config format');
    assert.equal(a.next().version, '0.3.0');

    const b = repo();
    b.commit('feat: first');
    b.tag('v1.4.2');
    b.commit('refactor: internals', 'BREAKING CHANGE: config renamed');
    assert.equal(b.next().version, '2.0.0');
  });

  it('--bump forces a release even without releasable commits', () => {
    const r = repo();
    r.commit('feat: first');
    r.tag('v1.2.3');
    r.commit('docs: only docs');
    assert.equal(r.next('--bump', 'patch').version, '1.2.4');
    assert.equal(r.next('--bump', 'minor').version, '1.3.0');
    assert.equal(r.next('--bump', 'major').version, '2.0.0');
  });

  it('rejects an invalid bump and a non-semver tag', () => {
    const r = repo();
    r.commit('feat: first');
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, '--bump', 'huge'], { cwd: r.dir, stdio: 'pipe' }));
    r.tag('v1.0');
    r.commit('fix: x');
    assert.throws(() => execFileSync(process.execPath, [SCRIPT], { cwd: r.dir, stdio: 'pipe' }));
  });

  it('writes its result to $GITHUB_OUTPUT when running in CI', () => {
    const r = repo();
    r.commit('feat: first');
    const out = join(tmp('gh-out'), 'out.txt');
    execFileSync(process.execPath, [SCRIPT], { cwd: r.dir, env: { ...process.env, GITHUB_OUTPUT: out } });
    assert.match(execFileSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(out)}, 'utf8'))`]).toString(), /release=true\nversion=0\.1\.0\ntag=v0\.1\.0/);
  });
});
