import assert from 'node:assert/strict';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createZip, crc32, extractZip, listZipEntries, readZipFileSync } from '../src/zip';
import { makeJar, tmp } from './helpers';

function buildWorld(dir: string): void {
  mkdirSync(join(dir, 'world', 'region'), { recursive: true });
  mkdirSync(join(dir, 'world', 'empty-dir'), { recursive: true });
  writeFileSync(join(dir, 'world', 'level.dat'), 'level data');
  writeFileSync(join(dir, 'world', 'empty.bin'), '');
  writeFileSync(join(dir, 'world', 'region', 'r.0.0.mca'), Buffer.alloc(100_000, 7));
  writeFileSync(join(dir, 'world', 'region', 'random.mca'), Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 251)));
}

describe('zip', () => {
  it('round-trips folders through createZip and extractZip', async () => {
    const src = tmp('zip-src');
    buildWorld(src);
    const out = join(tmp('zip-out'), 'backup.zip');
    const progress: number[] = [];
    const res = await createZip(out, src, ['world'], (p) => progress.push(p.doneBytes));
    assert.equal(res.skipped, 0);
    assert.ok(progress.length > 0 && progress.at(-1) === res.totalBytes);

    const dest = tmp('zip-dest');
    const files = await extractZip(out, dest);
    assert.equal(files, 4);
    assert.equal(readFileSync(join(dest, 'world', 'level.dat'), 'utf8'), 'level data');
    assert.deepEqual(readFileSync(join(dest, 'world', 'region', 'r.0.0.mca')), Buffer.alloc(100_000, 7));
    assert.equal(readFileSync(join(dest, 'world', 'empty.bin')).length, 0);
  });

  it('stores incompressible data and deflates compressible data', async () => {
    const src = tmp('zip-methods');
    buildWorld(src);
    const out = join(tmp('zip-out'), 'm.zip');
    await createZip(out, src, ['world']);
    const fd = openSync(out, 'r');
    try {
      const entries = listZipEntries(fd) ?? [];
      const byName = new Map(entries.map((e) => [e.name, e]));
      assert.equal(byName.get('world/region/r.0.0.mca')?.method, 8, 'repetitive data is deflated');
      assert.ok((byName.get('world/region/r.0.0.mca')?.compSize ?? Infinity) < 2000);
      assert.equal(byName.get('world/level.dat')?.crc, crc32(Buffer.from('level data')));
      assert.ok(entries.every((e) => !e.name.includes('\\')), 'names use forward slashes');
    } finally {
      closeSync(fd);
    }
  });

  it('reads single files from a jar and returns null for missing entries', async () => {
    const jar = join(tmp('zip-jar'), 'a.jar');
    await makeJar(jar, { main: 'a.b.Main' });
    assert.match(readZipFileSync(jar, 'META-INF/MANIFEST.MF')!.toString('utf8'), /Main-Class: a\.b\.Main/);
    assert.equal(readZipFileSync(jar, 'nope.txt'), null);
  });

  it('rejects entries that would escape the destination (zip slip)', async () => {
    const dir = tmp('zip-slip');
    const zip = join(dir, 'evil.zip');
    // hand-made central directory with a ../ entry (stored, empty)
    const name = Buffer.from('../evil.txt');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(0, 42);
    const cd = Buffer.concat([cen, name]);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(local.length + name.length, 16);
    writeFileSync(zip, Buffer.concat([local, name, cd, end]));
    await assert.rejects(extractZip(zip, join(dir, 'out')), /Unsafe path/);
    assert.equal(existsSync(join(dir, 'evil.txt')), false);
  });

  it('rejects files that are not zips', async () => {
    const dir = tmp('zip-bad');
    writeFileSync(join(dir, 'x.zip'), 'definitely not a zip file');
    await assert.rejects(extractZip(join(dir, 'x.zip'), join(dir, 'out')), /Not a valid zip/);
    const fd = openSync(join(dir, 'x.zip'), 'r');
    try {
      assert.equal(listZipEntries(fd), null);
    } finally {
      closeSync(fd);
    }
  });

  it('skips unreadable folders gracefully and reports an empty result for no files', async () => {
    const src = tmp('zip-empty');
    mkdirSync(join(src, 'world'));
    const out = join(tmp('zip-out'), 'e.zip');
    const res = await createZip(out, src, ['world']);
    assert.equal(res.totalBytes, 0);
    assert.equal(await extractZip(out, tmp('zip-dest')), 0);
  });

  it('crc32 matches the well-known check value', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });
});
