import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { downloadFile, fetchJson, fetchText } from '../src/net';
import { json, mockHttp, tmp } from './helpers';

const body = Buffer.from('server jar bytes '.repeat(5000));
const sha256 = createHash('sha256').update(body).digest('hex');
const sha1 = createHash('sha1').update(body).digest('hex');

async function server() {
  return mockHttp((req, res) => {
    switch (req.url) {
      case '/ok.jar':
        res.writeHead(200, { 'content-length': body.length });
        res.end(body);
        break;
      case '/nolength.jar':
        res.writeHead(200);
        res.end(body);
        break;
      case '/cut.jar':
        res.writeHead(200, { 'content-length': body.length });
        res.write(body.subarray(0, 100));
        setTimeout(() => res.destroy(), 30);
        break;
      case '/empty.jar':
        res.writeHead(200, { 'content-length': 0 });
        res.end();
        break;
      case '/stall.jar':
        res.writeHead(200, { 'content-length': body.length });
        res.write(body.subarray(0, 10)); // then nothing
        break;
      case '/data.json':
        json(res, { hello: 'world' });
        break;
      case '/bad.json':
        res.end('{not json');
        break;
      default:
        res.writeHead(req.url === '/boom' ? 500 : 404);
        res.end('no');
    }
  });
}

describe('downloadFile', () => {
  it('downloads, verifies checksums and reports progress', async () => {
    const mock = await server();
    const dest = join(tmp('dl'), 'out.jar');
    const seen: [number, number][] = [];
    const res = await downloadFile(`${mock.base}/ok.jar`, dest, { sha256, sha1, onProgress: (d, t) => seen.push([d, t]) });
    assert.equal(res.size, body.length);
    assert.equal(res.sha256, sha256);
    assert.deepEqual(readFileSync(dest), body);
    assert.deepEqual(seen.at(-1), [body.length, body.length]);
    assert.equal(existsSync(dest + '.part'), false);
  });

  it('works without Content-Length and replaces an existing file', async () => {
    const mock = await server();
    const dest = join(tmp('dl'), 'out.jar');
    writeFileSync(dest, 'old');
    await downloadFile(`${mock.base}/nolength.jar`, dest, { size: body.length });
    assert.deepEqual(readFileSync(dest), body);
  });

  it('rejects wrong SHA-256 and SHA-1 and leaves nothing behind', async () => {
    const mock = await server();
    const dir = tmp('dl');
    await assert.rejects(downloadFile(`${mock.base}/ok.jar`, join(dir, 'a.jar'), { sha256: 'deadbeef' }), /SHA-256 checksum mismatch/);
    await assert.rejects(downloadFile(`${mock.base}/ok.jar`, join(dir, 'b.jar'), { sha1: 'deadbeef' }), /SHA-1 checksum mismatch/);
    for (const f of ['a.jar', 'a.jar.part', 'b.jar', 'b.jar.part']) assert.equal(existsSync(join(dir, f)), false, f);
  });

  it('rejects truncated, empty, missing and failing downloads', async () => {
    const mock = await server();
    const dir = tmp('dl');
    await assert.rejects(downloadFile(`${mock.base}/cut.jar`, join(dir, 'c.jar')), /Connection lost|terminated|Incomplete/);
    await assert.rejects(downloadFile(`${mock.base}/empty.jar`, join(dir, 'e.jar')), /empty/);
    await assert.rejects(downloadFile(`${mock.base}/nothing`, join(dir, 'n.jar')), /HTTP 404/);
    await assert.rejects(downloadFile(`${mock.base}/boom`, join(dir, 'b.jar')), /HTTP 500/);
    assert.equal(existsSync(join(dir, 'c.jar.part')), false);
  });

  it('aborts a stalled download after the idle timeout', async () => {
    const mock = await server();
    const dir = tmp('dl');
    await assert.rejects(downloadFile(`${mock.base}/stall.jar`, join(dir, 's.jar'), { idleMs: 200 }), /stalled/);
    assert.equal(existsSync(join(dir, 's.jar.part')), false);
  });
});

describe('fetchJson / fetchText', () => {
  it('parses JSON and returns text', async () => {
    const mock = await server();
    assert.deepEqual(await fetchJson(`${mock.base}/data.json`), { hello: 'world' });
    assert.match(await fetchText(`${mock.base}/data.json`), /hello/);
  });
  it('throws on HTTP errors and invalid JSON', async () => {
    const mock = await server();
    await assert.rejects(fetchJson(`${mock.base}/boom`), /HTTP 500/);
    await assert.rejects(fetchJson(`${mock.base}/bad.json`));
  });
});
