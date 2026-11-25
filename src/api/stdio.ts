import { createInterface } from 'node:readline';
import type { Core } from '../core';
import { ApiSession } from './session';

/**
 * Headless mode (`mcli --api`): JSON lines on stdin/stdout, nothing else is printed.
 * When the controlling program closes stdin, the server is stopped gracefully and MCLI exits.
 */
export function runApi(core: Core): void {
  const session = new ApiSession(core, (line) => process.stdout.write(line + '\n'));
  const rl = createInterface({ input: process.stdin });
  session.attach();
  rl.on('line', (line) => void session.handleLine(line));
  const quit = () => void core.shutdown();
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  rl.on('close', () => {
    if (!core.quitting) quit();
  });
  core.banner();
}
