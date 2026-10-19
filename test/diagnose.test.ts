import assert from 'node:assert/strict';
import { readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { deepCheckJar, diagnoseLine, forgetJavaInfo, getJavaInfo, jarJavaMajor, parseJavaVersion, quickCheckJar } from '../src/diagnose';
import { makeJar, tmp } from './helpers';

describe('diagnoseLine', () => {
  const cases: [string, string][] = [
    ['[ERROR]: You need to agree to the EULA in order to run the server.', 'eula'],
    ['**** FAILED TO BIND TO PORT!', 'port'],
    ['java.net.BindException: Address already in use', 'port'],
    ['Error: Unable to access jarfile server.jar', 'jar-broken'],
    ['Error: Invalid or corrupt jarfile paper.jar', 'jar-broken'],
    ['java.lang.OutOfMemoryError: Java heap space', 'oom'],
    ['Error occurred during initialization of VM\nCould not reserve enough space for 8388608KB object heap', 'oom'],
    ['Failed to load level data', 'world'],
    ['Exception reading r.0.0.mca', 'world'],
    ['Incompatible mod set!', 'mods'],
    ['Considering it to be crashed, server will forcibly shutdown.', 'watchdog'],
  ];
  for (const [line, id] of cases) {
    it(`recognises ${id}: ${line.slice(0, 40)}`, () => {
      assert.equal(diagnoseLine(line)?.id, id);
    });
  }

  it('ignores normal log lines', () => {
    assert.equal(diagnoseLine('[12:00:00] [Server thread/INFO]: Steve joined the game'), null);
    assert.equal(diagnoseLine(''), null);
  });

  it('marks EULA, port and broken jar as fatal and memory as non-fatal', () => {
    assert.equal(diagnoseLine('agree to the EULA')?.fatal, true);
    assert.equal(diagnoseLine('Address already in use')?.fatal, true);
    assert.equal(diagnoseLine('java.lang.OutOfMemoryError')?.fatal, false);
  });

  it('turns a class file version into the required Java version', () => {
    const p = diagnoseLine('UnsupportedClassVersionError: x has been compiled by a more recent version of the Java Runtime (class file version 69.0), this version only recognizes class file versions up to 65.0');
    assert.equal(p?.id, 'java-old');
    assert.equal(p?.javaMajor, 25);
    assert.equal(p?.action, 'java-install');
    assert.equal(diagnoseLine('Unsupported class file major version 65')?.javaMajor, 21);
  });

  it('keeps the generic java-old problem when no version is present', () => {
    const p = diagnoseLine('java.lang.UnsupportedClassVersionError: something');
    assert.equal(p?.id, 'java-old');
    assert.equal(p?.javaMajor, undefined);
  });
});

describe('parseJavaVersion', () => {
  it('parses modern and legacy version strings', () => {
    assert.equal(parseJavaVersion('openjdk version "21.0.8" 2025-07-15\nOpenJDK Runtime Environment Temurin-21.0.8+9')?.major, 21);
    assert.equal(parseJavaVersion('java version "1.8.0_392"')?.major, 8);
    assert.equal(parseJavaVersion('openjdk version "17"')?.major, 17);
  });
  it('recognises vendors', () => {
    const v = (t: string) => parseJavaVersion(`openjdk version "21.0.1"\n${t}`)?.vendor;
    assert.equal(v('OpenJDK Runtime Environment Temurin-21'), 'Temurin');
    assert.equal(v('OpenJDK Runtime Environment Zulu21'), 'Zulu');
    assert.equal(v('OpenJDK Runtime Environment Corretto-21'), 'Corretto');
    assert.equal(v('OpenJDK Runtime Environment Microsoft-21'), 'Microsoft');
    assert.equal(v('Java(TM) SE Runtime Environment'), 'Oracle');
    assert.equal(v('OpenJDK Runtime Environment (build 21)'), 'OpenJDK');
    assert.equal(parseJavaVersion('java version "11.0.1"')?.vendor, 'Java');
  });
  it('returns null for unrelated output', () => {
    assert.equal(parseJavaVersion('command not found'), null);
  });
  it('getJavaInfo returns null for a missing executable and caches the result', async () => {
    forgetJavaInfo();
    assert.equal(await getJavaInfo('definitely-not-a-java-binary'), null);
    assert.equal(await getJavaInfo('definitely-not-a-java-binary'), null);
  });
});

describe('jar checks', () => {
  it('accepts a healthy jar (quick and deep)', async () => {
    const jar = join(tmp('jar'), 'ok.jar');
    await makeJar(jar, { main: 'net.minecraft.bundler.Main' });
    const quick = quickCheckJar(jar);
    assert.equal(quick.ok, true);
    assert.equal(quick.mainClass, 'net.minecraft.bundler.Main');
    assert.ok(quick.entries >= 3 && quick.size > 10_000);
    const progress: number[] = [];
    const deep = await deepCheckJar(jar, (done) => progress.push(done));
    assert.equal(deep.ok, true);
  });

  it('flags a missing file, a tiny file and a truncated jar', async () => {
    const dir = tmp('jar');
    assert.match(quickCheckJar(join(dir, 'missing.jar')).problems[0], /does not exist/);
    writeFileSync(join(dir, 'tiny.jar'), 'html error page');
    const tiny = quickCheckJar(join(dir, 'tiny.jar'));
    assert.equal(tiny.ok, false);
    assert.match(tiny.problems.join(' '), /bytes/);

    const jar = join(dir, 'cut.jar');
    await makeJar(jar, { main: 'x.Main' });
    truncateSync(jar, Math.floor(readFileSync(jar).length / 2));
    const cut = quickCheckJar(jar);
    assert.equal(cut.ok, false);
    assert.match(cut.problems.join(' '), /truncated|corrupt|valid/);
    assert.equal((await deepCheckJar(jar)).ok, false);
  });

  it('flags a jar without Main-Class', async () => {
    const jar = join(tmp('jar'), 'nomain.jar');
    await makeJar(jar, {});
    const r = quickCheckJar(jar);
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /Main-Class/);
  });

  it('only the deep check finds flipped bytes inside an entry', async () => {
    const jar = join(tmp('jar'), 'flip.jar');
    await makeJar(jar, { main: 'x.Main', blob: 200_000 });
    const raw = readFileSync(jar);
    // the blob is stored (random data): flip bytes well inside the file
    for (let i = 3000; i < 3010; i++) raw[i] ^= 0xff;
    writeFileSync(jar, raw);
    assert.equal(quickCheckJar(jar).ok, true);
    const deep = await deepCheckJar(jar);
    assert.equal(deep.ok, false);
    assert.match(deep.problems.join(' '), /checksum|wrong size|invalid|incorrect|unexpected|data/i);
  });

  it('reads the required Java version from version.json', async () => {
    const dir = tmp('jar');
    const a = join(dir, 'a.jar');
    await makeJar(a, { main: 'x.Main', files: { 'version.json': JSON.stringify({ id: '26.2', java_version: 25 }) } });
    assert.equal(jarJavaMajor(a), 25);
    const b = join(dir, 'b.jar');
    await makeJar(b, { main: 'x.Main', files: { 'version.json': JSON.stringify({ javaVersion: { majorVersion: 17 } }) } });
    assert.equal(jarJavaMajor(b), 17);
    const c = join(dir, 'c.jar');
    await makeJar(c, { main: 'x.Main' });
    assert.equal(jarJavaMajor(c), undefined);
    assert.equal(jarJavaMajor(join(dir, 'missing.jar')), undefined);
  });
});
