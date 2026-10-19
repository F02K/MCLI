import { closeSync, openSync, readSync, fstatSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { crc32 as zlibCrc32, deflateRaw, inflateRaw, inflateRawSync } from 'node:zlib';
import { promisify } from 'node:util';

const deflateRawAsync = promisify(deflateRaw);
const inflateRawAsync = promisify(inflateRaw);

const ZIP_LIMIT = 0xffffffff; // no ZIP64 support

export interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  size: number;
  crc: number;
  localOffset: number;
}

// ---------------------------------------------------------------- reading

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  const n = readSync(fd, buf, 0, len, pos);
  return buf.subarray(0, n);
}

/** Parses the central directory of a zip file. Returns null if it is not a (supported) zip. */
export function listZipEntries(fd: number): ZipEntry[] | null {
  const size = fstatSync(fd).size;
  const tailLen = Math.min(size, 65557);
  const tail = readAt(fd, size - tailLen, tailLen);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  const cd = readAt(fd, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) return null;
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    entries.push({
      method: cd.readUInt16LE(p + 10),
      compSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      crc: cd.readUInt32LE(p + 16),
      localOffset: cd.readUInt32LE(p + 42),
      name: cd.toString('utf8', p + 46, p + 46 + nameLen),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Returns the (still compressed) bytes of an entry. */
export function readEntryRaw(fd: number, e: ZipEntry): Buffer {
  const lh = readAt(fd, e.localOffset, 30);
  const dataPos = e.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  return readAt(fd, dataPos, e.compSize);
}

/** Reads one file from a zip synchronously (used for jar manifests). */
export function readZipFileSync(zipPath: string, entryName: string): Buffer | null {
  const fd = openSync(zipPath, 'r');
  try {
    const entry = listZipEntries(fd)?.find((e) => e.name === entryName);
    if (!entry) return null;
    const raw = readEntryRaw(fd, entry);
    return entry.method === 8 ? inflateRawSync(raw) : raw;
  } finally {
    closeSync(fd);
  }
}

/** Extracts a zip into destDir. Entries that would escape destDir are rejected. */
export async function extractZip(zipPath: string, destDir: string): Promise<number> {
  const fd = openSync(zipPath, 'r');
  try {
    const entries = listZipEntries(fd);
    if (!entries) throw new Error('Not a valid zip file');
    const root = resolve(destDir);
    let files = 0;
    for (const e of entries) {
      const target = resolve(root, e.name);
      if (target !== root && !target.startsWith(root + sep)) throw new Error(`Unsafe path in zip: ${e.name}`);
      if (e.name.endsWith('/')) {
        await mkdir(target, { recursive: true });
        continue;
      }
      const raw = readEntryRaw(fd, e);
      const data = e.method === 8 ? await inflateRawAsync(raw) : raw;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
      files++;
    }
    return files;
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------- writing

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  if (typeof zlibCrc32 === 'function') return zlibCrc32(buf);
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function walk(dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

export interface ZipProgress {
  doneBytes: number;
  totalBytes: number;
  skipped: number;
}

/**
 * Zips the given folders or files (relative to baseDir, stored with that relative path) into outPath.
 * Files that cannot be read (e.g. locked session.lock) are skipped and counted.
 */
export async function createZip(
  outPath: string,
  baseDir: string,
  folders: string[],
  onProgress: (p: ZipProgress) => void = () => {},
): Promise<ZipProgress> {
  const files: string[] = [];
  for (const f of folders) {
    const full = join(baseDir, f);
    if ((await stat(full)).isFile()) files.push(full);
    else await walk(full, files);
  }
  if (files.length > 65535) throw new Error('Too many files for a zip backup (limit 65535)');

  let totalBytes = 0;
  for (const f of files) totalBytes += (await stat(f)).size;
  const progress: ZipProgress = { doneBytes: 0, totalBytes, skipped: 0 };

  await mkdir(dirname(outPath), { recursive: true });
  const partial = outPath + '.partial';
  const fh = await open(partial, 'w');
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;
  try {
    for (const file of files) {
      let data: Buffer;
      let mtime: Date;
      try {
        data = await readFile(file);
        mtime = (await stat(file)).mtime;
      } catch {
        progress.skipped++;
        continue;
      }
      const name = Buffer.from(relative(baseDir, file).split(sep).join('/'), 'utf8');
      const crc = crc32(data);
      let body = data.length > 0 ? await deflateRawAsync(data) : data;
      let method = 8;
      if (body.length >= data.length) {
        body = data;
        method = 0;
      }
      if (offset + body.length + 100 + name.length > ZIP_LIMIT) throw new Error('Backup exceeds the 4 GB zip limit');
      const { time, date } = dosDateTime(mtime);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      await fh.write(Buffer.concat([local, name, body]));

      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0);
      cen.writeUInt16LE(20, 4);
      cen.writeUInt16LE(20, 6);
      cen.writeUInt16LE(0x0800, 8);
      cen.writeUInt16LE(method, 10);
      cen.writeUInt16LE(time, 12);
      cen.writeUInt16LE(date, 14);
      cen.writeUInt32LE(crc, 16);
      cen.writeUInt32LE(body.length, 20);
      cen.writeUInt32LE(data.length, 24);
      cen.writeUInt16LE(name.length, 28);
      cen.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([cen, name]));

      offset += local.length + name.length + body.length;
      count++;
      progress.doneBytes += data.length;
      onProgress(progress);
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(count, 8);
    end.writeUInt16LE(count, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    await fh.write(Buffer.concat([cd, end]));
  } catch (err) {
    await fh.close();
    await rm(partial, { force: true });
    throw err;
  }
  await fh.close();
  await rename(partial, outPath);
  return progress;
}
