import { saveConfigValue } from './config';
import type { Core } from './core';
import type { ProviderId } from './providers';

export const HELP_LINES = [
  'MCLI commands (prefix ":"):',
  '  :start / :stop / :restart   control the server',
  '  :backup                     create a world backup',
  '  :status                     detected server, health and problems',
  '  :versions <paper|vanilla|fabric|forge>   list Minecraft versions',
  '  :install <provider> <version>            download and install a server',
  '  :update [latest]            update to the newest build (latest = newest Minecraft version)',
  '  :verify / :repair           deep-check the server jar / reinstall it',
  '  :eula                       accept the Minecraft EULA',
  '  :java [install <n> | use <path|auto>]   list Java installs, install one, or choose one',
  '  :quit                       stop the server and exit MCLI',
  'Anything else is sent to the server console.',
];

/** Runs one ":command" typed by the user (without the leading colon). */
export function runCommand(core: Core, line: string): void {
  const [name, ...args] = line.split(/\s+/);
  switch (name) {
    case 'start':
      void core.startServer();
      break;
    case 'stop':
      if (core.server.state === 'stopped') core.info('Server is not running.');
      else void core.server.stop();
      break;
    case 'restart':
      void core.restartServer();
      break;
    case 'backup':
      void core.backups.create();
      break;
    case 'status':
      showStatus(core);
      break;
    case 'versions':
      void listVersions(core, args[0]);
      break;
    case 'install':
      if (args.length < 2 || !core.provider(args[0])) core.info('Usage: :install <paper|vanilla|fabric|forge> <minecraft version>');
      else void core.installVersion(args[0] as ProviderId, args[1], true);
      break;
    case 'update':
      void core.update(args[0] === 'latest');
      break;
    case 'verify':
      void core.verify();
      break;
    case 'repair':
      void core.repair();
      break;
    case 'eula':
      core.acceptEula();
      break;
    case 'java':
      void javaCommand(core, args);
      break;
    case 'quit':
    case 'exit':
      void core.shutdown();
      break;
    case 'help':
      HELP_LINES.forEach((l) => core.addLog(l, 'mcli'));
      break;
    default:
      core.info(`Unknown command "${name}". Type :help.`);
  }
}

function showStatus(core: Core): void {
  core.server.detect();
  const h = core.health;
  core.info(`${core.describeServer()} | state: ${core.server.state} | folder: ${core.cfg.serverDir}`);
  if (h.reachable) core.info(`Reachable on ${h.host}:${h.port} - ${h.version}, ${h.online}/${h.max} players, ${h.latencyMs} ms`);
  else if (core.server.state === 'running') core.info('Running, but not answering status pings (status disabled or not reachable).');
  for (const p of core.problems) core.info(`PROBLEM: ${p.title}. ${p.advice}`);
}

async function listVersions(core: Core, id?: string): Promise<void> {
  const prov = id ? core.provider(id) : undefined;
  if (!prov) return core.info('Usage: :versions <paper|vanilla|fabric|forge>');
  try {
    const v = await prov.versions(false);
    core.info(`${prov.label}: ${v.length} versions, newest first: ${v.slice(0, 15).join(', ')}`);
  } catch (err) {
    core.info(`Could not load versions: ${(err as Error).message}`);
  }
}

async function javaCommand(core: Core, args: string[]): Promise<void> {
  const [sub, arg] = args;
  if (sub === 'install') {
    const major = Number(arg);
    if (!Number.isInteger(major) || major < 8) return core.info('Usage: :java install <major version, e.g. 21>');
    const ok = await core.installJava(major);
    core.info(ok ? `Java ${major} is ready.` : `Java ${major} could not be installed.`);
    return;
  }
  if (sub === 'use') {
    if (!arg) return core.info('Usage: :java use <path to java | auto>');
    saveConfigValue(core.cfg, 'java', arg === 'auto' ? '' : args.slice(1).join(' '));
    return core.info(arg === 'auto' ? 'Java is chosen automatically per server now.' : `Java set to ${core.cfg.java}`);
  }
  const found = await core.java.scan();
  if (!found.length) core.info('No Java installation found. Use ":java install 21".');
  for (const j of found) core.info(`Java ${String(j.major).padEnd(3)} ${j.vendor.padEnd(10)} ${j.isJdk ? 'JDK' : 'JRE'} [${j.source}] ${j.path}`);
  const active = core.cfg.java ? `${core.cfg.java} (configured)` : core.server.javaPath ? `${core.server.javaPath} (automatic)` : 'chosen automatically at the next start';
  core.info(`Active: ${active}`);
}
