import { loadConfig } from './config';
import { runApi } from './api/stdio';
import { Core } from './core';
import { runPlain } from './plain';
import { Tui } from './tui/tui';
import { createRealTerm } from './tui/term';
import { VERSION } from './version';

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(`MCLI ${VERSION}`);
  process.exit(0);
}

let tui: Tui | undefined;
const fail = (err: unknown) => {
  tui?.close();
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

try {
  const core = new Core(loadConfig(process.cwd()));
  if (process.argv.includes('--api')) {
    runApi(core);
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    tui = new Tui(core, createRealTerm());
    core.banner();
    tui.start();
  } else {
    runPlain(core);
  }
} catch (err) {
  fail(err);
}
