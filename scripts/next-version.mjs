// Derives the next release version from the latest git tag and the commit
// messages since then (Conventional Commits). Writes release/version/tag to
// $GITHUB_OUTPUT when running in GitHub Actions, otherwise prints them.
//
// Usage: node scripts/next-version.mjs [--bump patch|minor|major]
//   --bump forces a bump even if no releasable commits exist.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FIRST_VERSION = '0.1.0';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export function parseVersion(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Returns 'major' | 'minor' | 'patch' | null for a list of { subject, body } commits. */
export function decideBump(commits, major) {
  let bump = null;
  const rank = { patch: 1, minor: 2, major: 3 };
  const raise = (b) => {
    if (!bump || rank[b] > rank[bump]) bump = b;
  };
  for (const { subject, body } of commits) {
    const m = /^(\w+)(\([^)]*\))?(!)?:/.exec(subject);
    const breaking = Boolean(m?.[3]) || /^BREAKING[ -]CHANGE:/m.test(body);
    if (breaking) raise(major >= 1 ? 'major' : 'minor'); // 0.x: breaking changes bump minor
    else if (m?.[1] === 'feat') raise('minor');
    else if (m && ['fix', 'perf', 'refactor'].includes(m[1])) raise('patch');
  }
  return bump;
}

export function applyBump([maj, min, pat], bump) {
  if (bump === 'major') return [maj + 1, 0, 0];
  if (bump === 'minor') return [maj, min + 1, 0];
  return [maj, min, pat + 1];
}

function readCommits(range) {
  const raw = execFileSync('git', ['log', range, '--format=%s%x1f%b%x1e'], { encoding: 'utf8' });
  return raw
    .split('\x1e')
    .map((c) => c.replace(/^\n/, ''))
    .filter(Boolean)
    .map((c) => {
      const [subject, body = ''] = c.split('\x1f');
      return { subject: subject.trim(), body };
    });
}

function main() {
  const forced = process.argv.includes('--bump') ? process.argv[process.argv.indexOf('--bump') + 1] : null;
  if (forced && !['patch', 'minor', 'major'].includes(forced)) throw new Error(`Invalid --bump value: ${forced}`);

  let lastTag = '';
  try {
    lastTag = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*');
  } catch {
    // no tag yet
  }

  let version = null;
  if (!lastTag) {
    version = FIRST_VERSION;
  } else {
    const current = parseVersion(lastTag);
    if (!current) throw new Error(`Latest tag "${lastTag}" is not vMAJOR.MINOR.PATCH`);
    const commits = readCommits(`${lastTag}..HEAD`);
    if (commits.length > 0) {
      const bump = forced ?? decideBump(commits, current[0]);
      if (bump) version = applyBump(current, bump).join('.');
    }
  }

  const out = { release: String(version !== null), version: version ?? '', tag: version ? `v${version}` : '' };
  const lines = Object.entries(out).map(([k, v]) => `${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
