import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerProcess, ServerState } from './server';

const JOIN_RE = /: (\S+) joined the game\s*$/;
const LEAVE_RE = /: (\S+) left the game\s*$/;
// Velocity: "[connected player] Name (/1.2.3.4:5678) has connected" / "... has disconnected"
const PROXY_JOIN_RE = /\[connected player\] (\S+) \(\S+\) has connected\s*$/;
const PROXY_LEAVE_RE = /\[connected player\] (\S+) \(\S+\) has disconnected\s*$/;
const LIST_RE = /There are (\d+) of a max of (\d+) players online:\s*(.*)$/;
const LIST_OLD_RE = /There are (\d+)\/(\d+) players online:\s*(.*)$/;

/** Tracks online players from the server log. Emits 'change'. */
export class PlayerTracker extends EventEmitter {
  /** name -> join time (epoch ms) */
  readonly online = new Map<string, number>();
  max: number | null = null;

  constructor(server: ServerProcess) {
    super();
    server.on('line', (line: string) => this.onLine(line));
    server.on('state', (state: ServerState) => {
      if (state === 'stopped' && this.online.size) {
        this.online.clear();
        this.emit('change');
      }
    });
  }

  private onLine(line: string): void {
    let m = JOIN_RE.exec(line) ?? PROXY_JOIN_RE.exec(line);
    if (m) {
      this.online.set(m[1], Date.now());
      this.emit('change');
      return;
    }
    m = LEAVE_RE.exec(line) ?? PROXY_LEAVE_RE.exec(line);
    if (m) {
      this.online.delete(m[1]);
      this.emit('change');
      return;
    }
    m = LIST_RE.exec(line) ?? LIST_OLD_RE.exec(line);
    if (m) {
      this.max = Number(m[2]);
      const names = m[3].split(',').map((n) => n.trim()).filter(Boolean);
      for (const n of names) if (!this.online.has(n)) this.online.set(n, Date.now());
      for (const n of [...this.online.keys()]) if (!names.includes(n)) this.online.delete(n);
      this.emit('change');
    }
  }
}

export interface ListEntry {
  name: string;
  detail: string;
}

export type ListKind = 'whitelist' | 'ops' | 'banned-players' | 'banned-ips';

const FILES: Record<ListKind, string> = {
  whitelist: 'whitelist.json',
  ops: 'ops.json',
  'banned-players': 'banned-players.json',
  'banned-ips': 'banned-ips.json',
};

interface RawEntry {
  name?: string;
  ip?: string;
  level?: number;
  reason?: string;
  created?: string;
  source?: string;
}

/** Reads one of the server's JSON lists (whitelist, ops, bans). Missing/invalid files give an empty list. */
export function readList(serverDir: string, kind: ListKind): ListEntry[] {
  const file = join(serverDir, FILES[kind]);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as RawEntry[];
    return raw.map((e) => {
      const name = e.name ?? e.ip ?? '?';
      if (kind === 'ops') return { name, detail: `level ${e.level ?? '?'}` };
      if (kind === 'banned-players' || kind === 'banned-ips') {
        const by = e.source ? `by ${e.source}` : '';
        return { name, detail: [e.reason, by].filter(Boolean).join(' - ') };
      }
      return { name, detail: '' };
    });
  } catch {
    return [];
  }
}
