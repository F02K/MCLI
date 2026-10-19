import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { JavaInfo } from '../src/diagnose';
import { JavaManager, javaRange, pickJava, scanJava, type JavaInstall } from '../src/java';
import { createZip } from '../src/zip';
import { json, mockHttp, tmp } from './helpers';

const EXE = process.platform === 'win32' ? 'java.exe' : 'java';

const mk = (major: number, source: JavaInstall['source'] = 'system', vendor = 'Temurin'): JavaInstall => ({
  path: `/j${major}-${source}`, home: '/', major, raw: String(major), vendor, source, isJdk: true,
});

/** Pretends every java under a "fake-java" folder runs and reports the major from its parent folder name. */
const fakeInfo = (exe: string): Promise<JavaInfo | null> => {
  const m = /fake-java[\\/](\d+)/.exec(exe) ?? /java[\\/](\d+)[\\/]/.exec(exe);
  return Promise.resolve(m && existsSync(exe) ? { major: Number(m[1]), raw: m[1], vendor: 'Temurin' } : null);
};

describe('pickJava', () => {
  const set = [mk(8), mk(11), mk(17), mk(21), mk(21, 'JAVA_HOME'), mk(26)];
  const name = (j?: JavaInstall) => (j ? `${j.major}/${j.source}` : 'none');

  it('takes the lowest version that is high enough, preferring JAVA_HOME on ties', () => {
    assert.equal(name(pickJava(set, 17)), '17/system');
    assert.equal(name(pickJava(set, 21)), '21/JAVA_HOME');
    assert.equal(name(pickJava(set, 22)), '26/system');
    assert.equal(name(pickJava(set, 27)), 'none');
  });
  it('without a requirement prefers 21, then 17, then the newest', () => {
    assert.equal(name(pickJava(set)), '21/JAVA_HOME');
    assert.equal(name(pickJava([mk(8), mk(17)])), '17/system');
    assert.equal(name(pickJava([mk(8), mk(11)])), '11/system');
    assert.equal(pickJava([]), undefined);
  });
  it('respects an upper bound (old Forge needs exactly 8)', () => {
    assert.equal(name(pickJava(set, 8, 8)), '8/system');
    assert.equal(pickJava(set.slice(1), 8, 8), undefined);
  });
  it('javaRange pins old Forge to Java 8 only', () => {
    assert.deepEqual(javaRange('forge', 8), { min: 8, max: 8 });
    assert.deepEqual(javaRange('forge', 17), { min: 17 });
    assert.deepEqual(javaRange('paper', 8), { min: 8 });
    assert.deepEqual(javaRange(undefined, undefined), { min: undefined });
  });
});

describe('scanJava', () => {
  it('finds installs in MCLI\'s own folder, tags them and sorts by version', async () => {
    const managed = join(tmp('scan'), 'java');
    for (const major of [21, 8]) {
      const bin = join(managed, String(major), 'jdk', 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, EXE), 'x');
    }
    const found = (await scanJava(managed, fakeInfo)).filter((j) => j.source === 'MCLI');
    assert.deepEqual(found.map((j) => j.major), [8, 21]);
    assert.ok(found.every((j) => j.vendor === 'Temurin' && j.path.endsWith(EXE)));
  });

  it('skips executables that do not run', async () => {
    const managed = join(tmp('scan'), 'java');
    mkdirSync(join(managed, '17', 'bin'), { recursive: true });
    writeFileSync(join(managed, '17', 'bin', EXE), 'x');
    const found = await scanJava(managed, () => Promise.resolve(null));
    assert.equal(found.filter((j) => j.source === 'MCLI').length, 0);
  });
});

// ---------------------------------------------------------------- JavaManager against a mock Adoptium API

async function jreZip(): Promise<{ file: Buffer; sha: string }> {
  const stage = tmp('jre-stage');
  const home = join(stage, 'jdk-99.0.1+1-jre');
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', EXE), 'fake java binary');
  writeFileSync(join(home, 'release'), 'JAVA_VERSION="99.0.1"');
  const out = join(tmp('jre-zip'), 'jre.zip');
  await createZip(out, stage, ['jdk-99.0.1+1-jre']);
  const file = readFileSync(out);
  return { file, sha: createHash('sha256').update(file).digest('hex') };
}

describe('JavaManager', () => {
  async function api(opts: { served?: Buffer; checksum?: string; assets?: unknown[] } = {}) {
    const { file, sha } = await jreZip();
    const served = opts.served ?? file;
    let base = '';
    const mock = await mockHttp((req, res) => {
      const url = req.url ?? '';
      if (url.startsWith('/info/available_releases')) json(res, { available_lts_releases: [8, 17, 21, 99] });
      else if (url.startsWith('/assets/latest/99/')) {
        json(res, opts.assets ?? [{ release_name: 'jdk-99.0.1+1', binary: { package: { link: `${base}/dl/jre.zip`, name: 'OpenJDK99U-jre_x64_windows_hotspot_99.zip', size: served.length, checksum: opts.checksum ?? sha } } }]);
      } else if (url === '/dl/jre.zip') {
        res.writeHead(200, { 'content-length': served.length });
        res.end(served);
      } else json(res, []);
    });
    base = mock.base;
    return mock.base;
  }
  const verify = (exe: string): Promise<JavaInfo | null> =>
    Promise.resolve(existsSync(exe) && exe.includes('jdk-99') ? { major: 99, raw: '99.0.1', vendor: 'Temurin' } : null);

  it('lists LTS versions from the API and falls back when it is unreachable', async () => {
    const base = await api();
    const dir = tmp('jm');
    assert.deepEqual(await new JavaManager(dir, () => {}, { api: base }).availableMajors(), [8, 17, 21, 99]);
    assert.deepEqual(await new JavaManager(dir, () => {}, { api: 'http://127.0.0.1:1' }).availableMajors(), [8, 11, 17, 21, 25]);
  });

  it('builds a download plan with checksum and size', async () => {
    const base = await api();
    const plan = await new JavaManager(tmp('jm'), () => {}, { api: base }).plan(99);
    assert.equal(plan.major, 99);
    assert.equal(plan.imageType, 'jre');
    assert.match(plan.name, /^OpenJDK99U/);
    assert.match(plan.sha256, /^[0-9a-f]{64}$/);
  });

  it('fails the plan when Temurin has no such version', async () => {
    const base = await api({ assets: [] });
    await assert.rejects(new JavaManager(tmp('jm'), () => {}, { api: base }).plan(99), /no Java 99/);
  });

  it('downloads, extracts, verifies and finds the new install', async () => {
    const base = await api();
    const dir = tmp('jm');
    const logs: string[] = [];
    const mgr = new JavaManager(dir, (t) => logs.push(t), { api: base, verify });
    let changes = 0;
    mgr.on('change', () => changes++);
    const inst = await mgr.install(99);
    assert.ok(inst, logs.join('\n'));
    assert.equal(inst.major, 99);
    assert.equal(inst.source, 'MCLI');
    assert.ok(inst.path.startsWith(join(dir, 'java', '99')));
    assert.equal(mgr.find(99)?.major, 99);
    assert.ok(changes > 2);
    assert.equal(mgr.busy, null);
    assert.equal(readdirSync(join(dir, 'java', '.downloads')).length, 0, 'archive removed');
    assert.equal(existsSync(join(dir, 'java', '.tmp-99')), false);
    // installing again replaces the old copy
    assert.ok(await mgr.install(99));
  });

  it('rejects a download whose checksum does not match', async () => {
    const base = await api({ checksum: 'deadbeef' });
    const dir = tmp('jm');
    const logs: string[] = [];
    const mgr = new JavaManager(dir, (t) => logs.push(t), { api: base, verify });
    assert.equal(await mgr.install(99), null);
    assert.match(logs.at(-1) ?? '', /checksum mismatch/);
    assert.equal(existsSync(join(dir, 'java', '99')), false);
  });

  it('fails cleanly when the installed Java does not run', async () => {
    const base = await api();
    const logs: string[] = [];
    const mgr = new JavaManager(tmp('jm'), (t) => logs.push(t), { api: base, verify: () => Promise.resolve(null) });
    assert.equal(await mgr.install(99), null);
    assert.match(logs.at(-1) ?? '', /does not run correctly/);
  });

  it('refuses archives that contain no Java runtime', async () => {
    const stage = tmp('empty-zip');
    writeFileSync(join(stage, 'readme.txt'), 'nothing here');
    const out = join(tmp('jre-zip'), 'e.zip');
    await createZip(out, stage, ['readme.txt']);
    const file = readFileSync(out);
    const base = await api({ served: file, checksum: createHash('sha256').update(file).digest('hex') });
    const logs: string[] = [];
    const mgr = new JavaManager(tmp('jm'), (t) => logs.push(t), { api: base, verify });
    assert.equal(await mgr.install(99), null);
    assert.match(logs.at(-1) ?? '', /does not contain a Java runtime/);
  });

  it('refuses zip entries that escape the install folder', async () => {
    const name = Buffer.from('../evil.txt');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(name.length, 28);
    const cd = Buffer.concat([cen, name]);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(local.length + name.length, 16);
    const evil = Buffer.concat([local, name, cd, end]);
    const base = await api({ served: evil, checksum: createHash('sha256').update(evil).digest('hex') });
    const dir = tmp('jm');
    const logs: string[] = [];
    const mgr = new JavaManager(dir, (t) => logs.push(t), { api: base, verify });
    assert.equal(await mgr.install(99), null);
    assert.match(logs.at(-1) ?? '', /Unsafe path/);
    assert.equal(existsSync(join(dir, 'java', 'evil.txt')), false);
  });

  it('does not run two installs at once', async () => {
    const base = await api();
    const logs: string[] = [];
    const mgr = new JavaManager(tmp('jm'), (t) => logs.push(t), { api: base, verify });
    const first = mgr.install(99);
    assert.equal(await mgr.install(99), null);
    assert.match(logs.join('\n'), /busy/);
    assert.ok(await first);
  });
});
