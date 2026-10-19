import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { loadConfig, type Config } from '../src/config';
import { Core, type CoreOptions } from '../src/core';
import type { Endpoints } from '../src/providers';
import type { Term } from '../src/tui/term';
import { Tui } from '../src/tui/tui';
import { createZip } from '../src/zip';

const created: string[] = [];

/** A fresh temp folder that is deleted when the test file finishes. */
export function tmp(name = 'mcli'): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  created.push(dir);
  return dir;
}

after(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls until `cond` is truthy (fails after `ms`). */
export async function waitFor(cond: () => unknown, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(15);
  }
}

export interface JarOptions {
  main?: string;
  /** Extra random payload so the jar passes the minimum size check. */
  blob?: number;
  files?: Record<string, string>;
}

/** Builds a real jar (zip with manifest) at `path`. */
export async function makeJar(path: string, opts: JarOptions = {}): Promise<void> {
  const stage = tmp('jar');
  mkdirSync(join(stage, 'META-INF'), { recursive: true });
  mkdirSync(join(stage, 'data'), { recursive: true });
  const manifest = ['Manifest-Version: 1.0', ...(opts.main === undefined ? [] : [`Main-Class: ${opts.main}`]), '', ''].join('\r\n');
  writeFileSync(join(stage, 'META-INF', 'MANIFEST.MF'), manifest);
  writeFileSync(join(stage, 'data', 'blob.bin'), randomBytes(opts.blob ?? 30_000));
  writeFileSync(join(stage, 'data', 'text.txt'), 'compressible '.repeat(2000));
  for (const [name, content] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(stage, name, '..'), { recursive: true });
    writeFileSync(join(stage, name), content);
  }
  await createZip(path, stage, ['META-INF', 'data', ...Object.keys(opts.files ?? {}).map((f) => f.split('/')[0]).filter((f) => f !== 'META-INF' && f !== 'data')]);
}

export interface Mock {
  base: string;
  close(): Promise<void>;
}

/** A local HTTP server; `handler` decides every response. */
export async function mockHttp(handler: (req: IncomingMessage, res: ServerResponse) => void, autoClose = true): Promise<Mock> {
  const server: Server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const mock = {
    base,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  if (autoClose) after(() => mock.close());
  return mock;
}

export function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/** A Minecraft "server" written in Node: prints Done, answers a few commands. */
export const FAKE_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const t = () => new Date().toTimeString().slice(0, 8);
const log = (m) => console.log('[' + t() + '] [Server thread/INFO]: ' + m);
const online = new Set();
log('Starting minecraft server version 1.21.8');
setTimeout(() => log('Done (0.3s)! For help, type "help"'), 100);
rl.on('line', (l) => {
  const [c, ...a] = l.split(' ');
  if (c === 'stop') { log('Stopping server'); process.exit(0); }
  else if (c === 'crash') process.exit(1);
  else if (c === 'join') { online.add(a[0]); log(a[0] + ' joined the game'); }
  else if (c === 'leave') { online.delete(a[0]); log(a[0] + ' left the game'); }
  else if (c === 'list') log('There are ' + online.size + ' of a max of 20 players online: ' + [...online].join(', '));
  else if (c === 'save-off') log('Automatic saving is now disabled');
  else if (c === 'save-all') setTimeout(() => log('Saved the game'), 50);
  else if (c === 'save-on') log('Automatic saving is now enabled');
  else log('ran: ' + l);
});
`;

export function customLaunch(dir: string, script = FAKE_SERVER): Partial<Config> {
  writeFileSync(join(dir, 'fake.js'), script);
  return { customLaunch: { command: process.execPath, args: ['fake.js'] } };
}

/** Writes mcli.json and returns a Core that never really exits the process. */
export function makeCore(dir: string, cfg: Record<string, unknown> = {}, opts: CoreOptions = {}): Core {
  writeFileSync(join(dir, 'mcli.json'), JSON.stringify({ serverDir: '.', ...cfg }));
  const core = new Core(loadConfig(dir), { restartDelayMs: 50, ...opts });
  core.exit = () => {};
  after(() => {
    core.server.kill();
    core.metrics.stop();
  });
  return core;
}

/** Terminal that renders ANSI output into a character grid so tests can read the screen. */
export class FakeTerm implements Term {
  grid: string[][] = [];
  cursor = { x: 0, y: 0, visible: false };
  private dataCb: (d: string) => void = () => {};
  private resizeCb: () => void = () => {};
  closed = false;

  constructor(
    public cols = 120,
    public rows = 34,
  ) {
    this.clear();
  }

  clear(): void {
    this.grid = Array.from({ length: this.rows }, () => Array<string>(this.cols).fill(' '));
  }

  write(s: string): void {
    let { x, y } = this.cursor;
    const re = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07]*\x07|([\s\S])/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      if (m[3] !== undefined) {
        if (y < this.rows && x < this.cols) this.grid[y][x] = m[3];
        x++;
      } else if (m[2] === 'H') {
        const [r, c] = m[1].split(';').map(Number);
        y = (r || 1) - 1;
        x = (c || 1) - 1;
      } else if (m[2] === 'K') {
        for (let i = x; i < this.cols; i++) this.grid[y][i] = ' ';
      } else if (m[2] === 'h' && m[1] === '?25') this.cursor.visible = true;
      else if (m[2] === 'l' && m[1] === '?25') this.cursor.visible = false;
    }
    this.cursor.x = x;
    this.cursor.y = y;
  }

  onData(cb: (d: string) => void): void {
    this.dataCb = cb;
  }
  onResize(cb: () => void): void {
    this.resizeCb = cb;
  }
  open(): void {
    this.closed = false;
  }
  close(): void {
    this.closed = true;
  }
  send(d: string): void {
    this.dataCb(d);
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.clear();
    this.resizeCb();
  }
  lines(): string[] {
    return this.grid.map((r) => r.join('').replace(/\s+$/, ''));
  }
  text(): string {
    return this.lines().join('\n');
  }
}

// ---------------------------------------------------------------- a fake "internet" with one Paper world


export interface ProviderWorld {
  endpoints: Endpoints;
  javaApi: string;
  base: string;
  sha256: string;
  /** Build numbers served for Paper 1.21.8 (default 59). */
  setPaperBuild(build: number): void;
}

/**
 * Serves Mojang, Paper, Fabric, Forge and Adoptium metadata plus the downloads themselves
 * (a real, valid jar), so install/update flows can run end to end without the internet.
 */
export async function providerWorld(): Promise<ProviderWorld> {
  const jarPath = join(tmp('world-jar'), 'server.jar');
  await makeJar(jarPath, { main: 'io.papermc.paperclip.Main', files: { 'version.json': JSON.stringify({ java_version: 21 }) } });
  const jar = readFileSync(jarPath);
  const sha256 = createHash('sha256').update(jar).digest('hex');
  const jreStage = tmp('world-jre');
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  mkdirSync(join(jreStage, 'fakejdk-99', 'bin'), { recursive: true });
  writeFileSync(join(jreStage, 'fakejdk-99', 'bin', exe), 'fake java');
  const jreZipPath = join(tmp('world-jre-zip'), 'jre.zip');
  await createZip(jreZipPath, jreStage, ['fakejdk-99']);
  const jre = readFileSync(jreZipPath);
  const jreSha = createHash('sha256').update(jre).digest('hex');

  let paperBuild = 59;
  let base = '';
  const mock = await mockHttp((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    const file = (body: Buffer) => {
      res.writeHead(200, { 'content-length': body.length });
      res.end(body);
    };
    const paperDl = (id: number) => ({ id, channel: 'STABLE', downloads: { 'server:default': { name: `paper-1.21.8-${id}.jar`, url: `${base}/dl/paper-1.21.8-${id}.jar`, size: jar.length, checksums: { sha256 } } } });
    if (url.startsWith('/dl/')) return file(url.endsWith('.zip') ? jre : jar);
    switch (url) {
      case '/mojang/manifest.json':
        return json(res, { versions: [{ id: '1.21.8', type: 'release', url: `${base}/mojang/1.21.8.json` }, { id: '1.20.4', type: 'release', url: `${base}/mojang/1.20.4.json` }] });
      case '/mojang/1.21.8.json':
        return json(res, { javaVersion: { majorVersion: 21 }, downloads: { server: { sha1: createHash('sha1').update(jar).digest('hex'), size: jar.length, url: `${base}/dl/minecraft_server.1.21.8.jar` } } });
      case '/mojang/1.20.4.json':
        return json(res, { javaVersion: { majorVersion: 17 }, downloads: { server: { sha1: createHash('sha1').update(jar).digest('hex'), size: jar.length, url: `${base}/dl/minecraft_server.1.20.4.jar` } } });
      case '/paper':
        return json(res, { versions: { '1.21': ['1.21.8'], '1.20': ['1.20.4'] } });
      case '/paper/versions/1.21.8/builds':
        return json(res, [paperDl(paperBuild)]);
      case '/paper/versions/1.20.4/builds':
        return json(res, [{ ...paperDl(7), downloads: { 'server:default': { ...paperDl(7).downloads['server:default'], name: 'paper-1.20.4-7.jar', url: `${base}/dl/paper-1.20.4-7.jar` } } }]);
      case '/fabric/game':
        return json(res, [{ version: '1.21.8', stable: true }]);
      case '/fabric/loader':
        return json(res, [{ version: '0.19.5', stable: true }]);
      case '/fabric/installer':
        return json(res, [{ version: '1.1.2', stable: true }]);
      case '/forge/promos.json':
        return json(res, { promos: { '1.20.1-recommended': '47.3.0' } });
      case '/adoptium/info/available_releases':
        return json(res, { available_lts_releases: [8, 17, 21, 99] });
      case '/adoptium/assets/latest/99/hotspot':
        return json(res, [{ release_name: 'jdk-99.0.1+1', binary: { package: { link: `${base}/dl/jre.zip`, name: 'OpenJDK99U-jre_x64_windows_hotspot_99.zip', size: jre.length, checksum: jreSha } } }]);
      default:
        if (url.startsWith('/fabric/loader/') && url.endsWith('/server/jar')) return file(jar);
        res.writeHead(404);
        res.end('no');
    }
  });
  base = mock.base;
  return {
    base,
    sha256,
    endpoints: { mojang: `${base}/mojang/manifest.json`, paper: `${base}/paper`, fabric: `${base}/fabric`, forgePromos: `${base}/forge/promos.json`, forgeMaven: `${base}/forge/maven` },
    javaApi: `${base}/adoptium`,
    setPaperBuild: (b) => {
      paperBuild = b;
    },
  };
}

/** Pretends only executables inside a "fakejdk-<major>" folder run (the machine's real Javas are ignored). */
export const fakeJavaVerify = (exe: string): Promise<{ major: number; raw: string; vendor: string } | null> => {
  const m = /fakejdk-(\d+)/.exec(exe);
  return Promise.resolve(m && existsSync(exe) ? { major: Number(m[1]), raw: `${m[1]}.0.1`, vendor: 'Temurin' } : null);
};

/** Puts a fake Java <major> into MCLI's own java folder below `configDir`. */
export function addFakeJava(configDir: string, major: number): string {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const bin = join(configDir, 'java', String(major), `fakejdk-${major}`, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, exe), 'fake java');
  return join(bin, exe);
}

// ---------------------------------------------------------------- headless UI rig


export const K = {
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  enter: '\r', esc: '\x1b', tab: '\t', shiftTab: '\x1b[Z', bs: '\x7f', del: '\x1b[3~',
  pgup: '\x1b[5~', pgdn: '\x1b[6~', home: '\x1b[H', end: '\x1b[F',
  f: (n: number) => ['\x1bOP', '\x1bOQ', '\x1bOR', '\x1bOS', '\x1b[15~', '\x1b[17~', '\x1b[18~'][n - 1],
  alt: (n: number) => `\x1b${n}`,
  ctrl: (c: string) => String.fromCharCode(c.charCodeAt(0) - 96),
  click: (x: number, y: number) => `\x1b[<0;${x};${y}M`,
  wheelUp: '\x1b[<64;10;10M',
  wheelDown: '\x1b[<65;10;10M',
};

export interface Rig {
  core: Core;
  term: FakeTerm;
  tui: Tui;
  exits: number[];
  /** Sends keys and lets queued renders run. */
  press(...keys: string[]): Promise<void>;
  /** Types text one key at a time. */
  type(text: string): Promise<void>;
  settle(ms?: number): Promise<void>;
  /** Forces a redraw (for state that was changed without an event). */
  refresh(): Promise<void>;
  /** Takes one metrics sample so the resource graphs have data. */
  metrics(): Promise<void>;
  screen(): string;
}

export async function tuiRig(dir: string, cfg: Record<string, unknown> = {}, opts: CoreOptions = {}, size: [number, number] = [120, 34]): Promise<Rig> {
  const core = makeCore(dir, cfg, opts);
  const term = new FakeTerm(size[0], size[1]);
  const tui = new Tui(core, term);
  tui.start();
  const exits: number[] = [];
  core.exit = (code) => void exits.push(code);
  const rig: Rig = {
    core, term, tui, exits,
    settle: (ms = 25) => sleep(ms),
    async press(...keys) {
      for (const k of keys) term.send(k);
      await sleep(25);
    },
    async type(text) {
      for (const ch of text) term.send(ch);
      await sleep(25);
    },
    refresh: () => (tui.render(), sleep(30)),
    metrics: () => core.metrics.sample(),
    screen: () => term.text(),
  };
  await rig.settle();
  after(() => tui.close());
  return rig;
}
