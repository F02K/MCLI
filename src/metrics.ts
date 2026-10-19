import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import type { ServerProcess } from './server';

const HISTORY = 60;
const INTERVAL_MS = 2000;
const WIN_INTERVAL_MS = 10_000; // tasklist /V is slow, sample less often

function push(arr: number[], v: number): void {
  arr.push(v);
  if (arr.length > HISTORY) arr.shift();
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

/** "0:01:23" -> seconds */
function parseCpuTime(text: string): number | null {
  const m = /(\d+):(\d+):(\d+)/.exec(text);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/**
 * Samples system CPU/RAM and the server process RAM/CPU (no native modules).
 * Linux/macOS use `ps`, Windows uses `tasklist`. Emits 'sample'.
 */
export class Metrics extends EventEmitter {
  readonly sysCpu: number[] = [];
  readonly sysMem: number[] = [];
  readonly procMem: number[] = []; // bytes
  readonly procCpu: number[] = []; // % of the whole machine
  private last = cpuTimes();
  private timer: NodeJS.Timeout | null = null;
  private lastProc: { cpuSec: number; at: number } | null = null;
  private lastProcSample = 0;
  private sampling = false;

  constructor(private server: ServerProcess) {
    super();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sample(), INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get totalMem(): number {
    return os.totalmem();
  }

  /** Takes one sample (called by the timer; public so tests can drive it). */
  async sample(): Promise<void> {
    const now = cpuTimes();
    const dTotal = now.total - this.last.total;
    const dIdle = now.idle - this.last.idle;
    this.last = now;
    push(this.sysCpu, dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0);
    push(this.sysMem, Math.round((1 - os.freemem() / os.totalmem()) * 100));

    const pid = this.server.pid;
    if (pid && this.server.state !== 'stopped') await this.sampleProcess(pid);
    else {
      this.lastProc = null;
      push(this.procMem, 0);
      push(this.procCpu, 0);
    }
    this.emit('sample');
  }

  private async sampleProcess(pid: number): Promise<void> {
    const win = process.platform === 'win32';
    if (win && Date.now() - this.lastProcSample < WIN_INTERVAL_MS) {
      // keep the graphs moving with the last known values
      push(this.procMem, this.procMem[this.procMem.length - 1] ?? 0);
      push(this.procCpu, this.procCpu[this.procCpu.length - 1] ?? 0);
      return;
    }
    if (this.sampling) return;
    this.sampling = true;
    this.lastProcSample = Date.now();
    try {
      const cores = os.cpus().length || 1;
      if (win) {
        const out = await run('tasklist', ['/V', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
        const cols = out.trim().split('","').map((c) => c.replace(/^"|"$/g, ''));
        const kb = Number((cols[4] ?? '').replace(/\D/g, ''));
        const cpuSec = parseCpuTime(cols[7] ?? '');
        push(this.procMem, kb * 1024);
        let cpu = this.procCpu[this.procCpu.length - 1] ?? 0;
        if (cpuSec !== null) {
          if (this.lastProc) {
            const dt = (Date.now() - this.lastProc.at) / 1000;
            if (dt > 0) cpu = Math.max(0, Math.min(100, Math.round(((cpuSec - this.lastProc.cpuSec) / dt / cores) * 100)));
          }
          this.lastProc = { cpuSec, at: Date.now() };
        }
        push(this.procCpu, cpu);
      } else {
        const out = await run('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)]);
        const [rss, pcpu] = out.trim().split(/\s+/).map(Number);
        push(this.procMem, (rss || 0) * 1024);
        push(this.procCpu, Math.min(100, Math.round((pcpu || 0) / cores)));
      }
    } finally {
      this.sampling = false;
    }
  }
}
