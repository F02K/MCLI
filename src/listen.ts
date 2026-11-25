import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerType } from './detect';
import { Properties } from './properties';

export interface ListenAddress {
  /** Bind address as configured ('0.0.0.0' = all interfaces). */
  host: string;
  port: number;
}

export const VELOCITY_DEFAULT_PORT = 25565;

/** Reads `bind = "0.0.0.0:25565"` from velocity.toml (default when the file or key is missing). */
export function velocityBind(serverDir: string): ListenAddress {
  const file = join(serverDir, 'velocity.toml');
  const fallback = { host: '0.0.0.0', port: VELOCITY_DEFAULT_PORT };
  if (!existsSync(file)) return fallback;
  const m = /^\s*bind\s*=\s*"([^"]+)"/m.exec(readFileSync(file, 'utf8'));
  if (!m) return fallback;
  const idx = m[1].lastIndexOf(':');
  const port = Number(m[1].slice(idx + 1));
  return { host: idx > 0 ? m[1].slice(0, idx) : fallback.host, port: Number.isInteger(port) && port > 0 ? port : fallback.port };
}

/** Where the server accepts Minecraft connections: velocity.toml for a proxy, server.properties otherwise. */
export function listenAddress(serverDir: string, type: ServerType | undefined): ListenAddress {
  if (type === 'velocity') return velocityBind(serverDir);
  const props = new Properties(serverDir);
  return { host: props.get('server-ip') || '0.0.0.0', port: Number(props.get('server-port') || 25565) };
}
