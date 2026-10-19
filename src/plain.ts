import { createInterface } from 'node:readline';
import type { Core, LogEntry } from './core';

/** Non-interactive mode (pipes, CI, no TTY): log lines on stdout, commands from stdin. */
export function runPlain(core: Core): void {
  const rl = createInterface({ input: process.stdin });
  core.on('log', (e: LogEntry) => console.log(e.text));
  rl.on('line', (line) => core.exec(line));
  const quit = () => void core.shutdown();
  process.on('SIGINT', quit);
  rl.on('close', () => {
    if (!core.quitting) quit();
  });
  core.banner();
}
