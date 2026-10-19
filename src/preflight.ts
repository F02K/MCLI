import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { Core } from './core';
import { jarJavaMajor, quickCheckJar } from './diagnose';
import { readInstallMeta } from './installmeta';
import { javaRange } from './java';
import { javaForMc } from './providers';

function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code !== 'EADDRINUSE'));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/** Checks everything that can be checked before launching; adds Problems and returns false on failure. */
export async function preflight(core: Core): Promise<boolean> {
  core.clearProblems();
  if (core.cfg.customLaunch) return true;
  const { serverDir } = core.cfg;
  const det = core.server.detect();
  if (!det) {
    core.addProblem({
      id: 'no-server',
      title: 'No server found in the server folder',
      advice: 'Install one in the Versions tab (I).',
      fatal: true,
      action: 'versions',
    });
    return false;
  }

  if (det.jar) {
    const check = quickCheckJar(join(serverDir, det.jar));
    if (!check.ok) {
      core.addProblem({
        id: 'jar-broken',
        title: `${det.jar} is broken`,
        advice: `${check.problems[0]} Reinstall it in the Versions tab (R = repair).`,
        fatal: true,
        action: 'versions',
      });
      return false;
    }
  }

  const meta = readInstallMeta(serverDir);
  const known = meta?.javaMajor ?? (det.jar ? jarJavaMajor(join(serverDir, det.jar)) : undefined) ?? (det.mcVersion ? javaForMc(det.mcVersion) : undefined);
  const required = Math.max(known ?? 0, core.learnedJava) || undefined;
  const java = await ensureJava(core, required, meta?.provider ?? det.type);
  if (!java) return false;
  core.server.javaPath = java;

  const eulaFile = join(serverDir, 'eula.txt');
  if (existsSync(eulaFile) && /eula\s*=\s*false/i.test(readFileSync(eulaFile, 'utf8'))) {
    core.addProblem({
      id: 'eula',
      title: 'The Minecraft EULA is not accepted',
      advice: 'Accept the EULA to run the server (Dashboard: press E).',
      fatal: true,
      action: 'eula',
    });
    return false;
  }

  const props = core.properties;
  const port = Number(props.get('server-port') || 25565);
  if (Number.isInteger(port) && !(await portFree(port, props.get('server-ip') || '0.0.0.0'))) {
    core.addProblem({
      id: 'port',
      title: `Port ${port} is already in use`,
      advice: 'Another program (or server) uses this port. Stop it or change server-port in Settings.',
      fatal: true,
      action: 'settings',
    });
    return false;
  }
  return true;
}

/**
 * Finds (or, if allowed, installs) a Java that fits the server. Returns the executable, or
 * null after adding a Problem that explains what is wrong.
 */
export async function ensureJava(core: Core, required: number | undefined, provider: string | undefined): Promise<string | null> {
  const { cfg } = core;
  const range = javaRange(provider, required);
  const fits = (major: number) => (range.min === undefined || major >= range.min) && (range.max === undefined || major <= range.max);

  if (cfg.java) {
    const info = await core.javaInfo(cfg.java);
    if (!info) {
      core.addProblem({
        id: 'java-missing',
        title: `The configured Java was not found: ${cfg.java}`,
        advice: 'Fix the path in Settings > MCLI ("java"), or clear it so MCLI finds a Java automatically.',
        fatal: true,
        action: 'settings',
      });
      return null;
    }
    if (!fits(info.major)) {
      core.addProblem({
        id: 'java-old',
        title: `This server needs Java ${required}${range.max ? ' (exactly)' : '+'}, but the configured Java is ${info.major}`,
        advice: 'Clear "java" in Settings > MCLI so MCLI picks or installs a fitting Java automatically.',
        fatal: true,
        action: 'settings',
      });
      return null;
    }
    return cfg.java;
  }

  if (!core.java.scanned) await core.java.scan();
  let pick = core.java.find(range.min, range.max);
  if (!pick) {
    await core.java.scan(); // maybe a matching Java was installed since the last scan
    pick = core.java.find(range.min, range.max);
  }
  if (!pick) {
    const need = required ?? 21;
    if (cfg.javaAutoInstall) {
      core.info(`No Java ${need} found - installing it automatically (javaAutoInstall is on).`);
      pick = (await core.java.install(need)) ?? undefined;
    }
    if (!pick) {
      core.addProblem({
        id: 'java-install',
        title: `Java ${need} is required but not installed`,
        advice: 'Press J on the Dashboard to download and install it (Eclipse Temurin, about 40 MB). Your other Java installs stay untouched.',
        fatal: true,
        action: 'java-install',
        javaMajor: need,
      });
      return null;
    }
  }
  const note = `Using Java ${pick.major} (${pick.vendor}) at ${pick.path}`;
  if (note !== core.lastJavaNote) {
    core.lastJavaNote = note;
    core.info(note);
  }
  return pick.path;
}
