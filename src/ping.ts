import { connect } from 'node:net';

export interface PingResult {
  latencyMs: number;
  version: string;
  protocol: number;
  motd: string;
  online: number;
  max: number;
}

function varint(n: number): Buffer {
  const bytes: number[] = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

/** Reads a varint at `pos`; returns null if the buffer ends first. */
function readVarint(buf: Buffer, pos: number): { value: number; size: number } | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (pos + i >= buf.length) return null;
    const b = buf[pos + i];
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return { value, size: i + 1 };
  }
  throw new Error('Malformed varint');
}

function packet(id: number, data: Buffer): Buffer {
  const body = Buffer.concat([varint(id), data]);
  return Buffer.concat([varint(body.length), body]);
}

interface Chat {
  text?: string;
  extra?: Chat[];
}

function flattenChat(c: string | Chat | undefined): string {
  if (!c) return '';
  if (typeof c === 'string') return c;
  return (c.text ?? '') + (c.extra ?? []).map(flattenChat).join('');
}

/**
 * Minecraft Server List Ping: proves a server really accepts connections and reports its
 * version, MOTD and player counts. Rejects on timeout or protocol errors.
 */
export function pingServer(host: string, port: number, timeoutMs = 3000): Promise<PingResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = connect({ host, port });
    let buf = Buffer.alloc(0);
    const finish = (err: Error | null, result?: PingResult) => {
      socket.destroy();
      if (err) reject(err);
      else resolve(result!);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('timeout')));
    socket.on('error', (e) => finish(e));
    socket.on('close', () => finish(new Error('connection closed')));
    socket.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const port16 = Buffer.alloc(2);
      port16.writeUInt16BE(port);
      const handshake = Buffer.concat([varint(765), varint(hostBuf.length), hostBuf, port16, varint(1)]);
      socket.write(Buffer.concat([packet(0x00, handshake), packet(0x00, Buffer.alloc(0))]));
    });
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const len = readVarint(buf, 0);
        if (!len || buf.length < len.size + len.value) return; // wait for the rest
        let pos = len.size;
        const id = readVarint(buf, pos)!;
        pos += id.size;
        if (id.value !== 0x00) throw new Error(`unexpected packet ${id.value}`);
        const strLen = readVarint(buf, pos)!;
        pos += strLen.size;
        const json = JSON.parse(buf.toString('utf8', pos, pos + strLen.value)) as {
          version?: { name?: string; protocol?: number };
          players?: { online?: number; max?: number };
          description?: string | Chat;
        };
        finish(null, {
          latencyMs: Date.now() - started,
          version: json.version?.name ?? '?',
          protocol: json.version?.protocol ?? 0,
          motd: flattenChat(json.description).replace(/§./g, '').trim(),
          online: json.players?.online ?? 0,
          max: json.players?.max ?? 0,
        });
      } catch (e) {
        finish(e as Error);
      }
    });
  });
}
