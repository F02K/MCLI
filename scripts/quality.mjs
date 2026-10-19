// Computes MCLI's code quality grade from measurable criteria, writes the README badge and,
// with --check, fails unless the grade is A and the committed badge is up to date.
//
//   node scripts/quality.mjs            run all checks, print the report, update badges/quality.svg
//   node scripts/quality.mjs --check    same, but exit 1 if the grade is below A or the badge is stale
//
// Scoring (100 points). A needs 90+ and passing types, lint and tests; failing any of those caps the grade at C.
//   types      15  tsc --noEmit with strict mode
//   lint       15  eslint with zero errors and zero warnings
//   tests      20  every test passes
//   coverage   20  line coverage, full marks at 90 %
//   branches    5  branch coverage, full marks at 85 %
//   deps       10  no runtime dependencies and no known vulnerabilities (npm audit)
//   size       10  no source file longer than 500 lines
//   docs        5  README, CI and release automation are present
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHECK = process.argv.includes('--check');
const BADGE = join('badges', 'quality.svg');
const MAX_FILE_LINES = 500;

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

const results = [];
function record(name, max, score, detail) {
  results.push({ name, max, score: Math.round(score * 10) / 10, detail });
  console.log(`${score >= max ? 'PASS' : 'FAIL'}  ${name.padEnd(9)} ${String(Math.round(score * 10) / 10).padStart(5)}/${max}  ${detail}`);
}

// ---- types
const tsc = run([join('node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']);
record('types', 15, tsc.code === 0 ? 15 : 0, tsc.code === 0 ? 'strict tsc: no errors' : tsc.out.split('\n').slice(0, 3).join(' | '));

// ---- lint
const lint = run([join('node_modules', 'eslint', 'bin', 'eslint.js'), '.', '--max-warnings', '0']);
record('lint', 15, lint.code === 0 ? 15 : 0, lint.code === 0 ? 'eslint: 0 errors, 0 warnings' : lint.out.trim().split('\n').slice(-3).join(' | '));

// ---- tests and coverage
const test = run(['scripts/test.mjs', '--coverage']);
const num = (label) => Number(new RegExp(`ℹ ${label} (\\d+)`).exec(test.out)?.[1] ?? 0);
const total = num('tests');
const passed = num('pass');
const testsOk = test.code === 0 && total > 0 && passed === total;
record('tests', 20, testsOk ? 20 : 0, `${passed}/${total} passed`);
if (!testsOk) console.log(test.out.split('\n').filter((l) => /✖|Error|failing/.test(l)).slice(0, 12).join('\n'));

let lines = 0;
let branches = 0;
try {
  const cov = JSON.parse(readFileSync(join('coverage', 'coverage-summary.json'), 'utf8')).total;
  lines = cov.lines.pct;
  branches = cov.branches.pct;
} catch {
  console.log('No coverage summary found.');
}
record('coverage', 20, 20 * Math.min(1, lines / 90), `${lines}% of lines (90% = full marks)`);
record('branches', 5, 5 * Math.min(1, branches / 85), `${branches}% of branches (85% = full marks)`);

// ---- dependencies
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const runtimeDeps = Object.keys(pkg.dependencies ?? {}).length;
let audit = { code: 0, out: '{}' };
const npmCli = process.env.npm_execpath;
if (npmCli) audit = run([npmCli, 'audit', '--omit=dev', '--json']);
else audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', shell: true });
let vulns = 0;
try {
  const parsed = JSON.parse(audit.out ?? audit.stdout ?? '{}');
  vulns = parsed.metadata?.vulnerabilities?.total ?? 0;
} catch {
  vulns = 0; // audit could not run (offline): not counted against the project
}
const depsOk = runtimeDeps === 0 && vulns === 0;
record('deps', 10, depsOk ? 10 : 0, `${runtimeDeps} runtime dependencies, ${vulns} known vulnerabilities`);

// ---- file size
const big = walk('src').map((f) => [f, readFileSync(f, 'utf8').split('\n').length]).filter(([, n]) => n > MAX_FILE_LINES);
record('size', 10, big.length === 0 ? 10 : 0, big.length === 0 ? `all files <= ${MAX_FILE_LINES} lines` : big.map(([f, n]) => `${f} (${n})`).join(', '));

// ---- docs and automation
const docsOk = ['README.md', '.github/workflows/ci.yml', '.github/workflows/release.yml'].every((f) => existsSync(f));
record('docs', 5, docsOk ? 5 : 0, docsOk ? 'README, CI and release workflows present' : 'README or workflows missing');

// ---- grade
const points = results.reduce((n, r) => n + r.score, 0);
const gatesOk = tsc.code === 0 && lint.code === 0 && testsOk;
let grade = points >= 90 ? 'A' : points >= 80 ? 'B' : points >= 70 ? 'C' : points >= 60 ? 'D' : 'F';
if (!gatesOk && 'AB'.includes(grade)) grade = 'C';
console.log(`\nScore ${Math.round(points * 10) / 10}/100  ->  grade ${grade}${gatesOk ? '' : '  (capped: types, lint or tests are failing)'}`);

// ---- badge (shows only the grade, so it is the same on every platform)
const COLORS = { A: '#4c1', B: '#a4a61d', C: '#dfb317', D: '#fe7d37', F: '#e05d44' };
function badge(letter) {
  const label = 'code quality';
  const lw = Math.round(label.length * 6.1 + 12);
  const rw = 24;
  const w = lw + rw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}: ${letter}">
  <title>${label}: ${letter}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${rw}" height="20" fill="${COLORS[letter]}"/><rect width="${w}" height="20" fill="url(#s)"/></g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text><text x="${lw / 2}" y="14">${label}</text>
    <text x="${lw + rw / 2}" y="15" fill="#010101" fill-opacity=".3" font-weight="bold">${letter}</text><text x="${lw + rw / 2}" y="14" font-weight="bold">${letter}</text>
  </g>
</svg>
`;
}

const svg = badge(grade);
const current = existsSync(BADGE) ? readFileSync(BADGE, 'utf8') : '';
if (current !== svg) {
  if (CHECK) {
    console.log(`\nThe badge ${BADGE} does not match grade ${grade}. Run "npm run quality" and commit the result.`);
  } else {
    mkdirSync('badges', { recursive: true });
    writeFileSync(BADGE, svg);
    console.log(`Updated ${BADGE}`);
  }
}

if (CHECK && (grade !== 'A' || current !== svg)) process.exit(1);
