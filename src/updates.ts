import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { Core } from './core';
import { deepCheckJar, type JarCheck } from './diagnose';
import { readInstallMeta } from './installmeta';
import type { DownloadPlan, ProviderId } from './providers';

export interface InstalledInfo {
  provider?: ProviderId;
  mcVersion?: string;
  identity?: string;
  file?: string;
  javaMajor?: number;
}

export interface UpdateInfo {
  checkedAt: number;
  error?: string;
  /** Installed software cannot be tracked (not installed through MCLI / unknown type). */
  unknown?: boolean;
  /** A newer build of the same Minecraft version. */
  sameMc?: DownloadPlan;
  /** A newer Minecraft version is available from the same provider. */
  newerMc?: string;
}

export interface VerifyResult {
  at: number;
  check: JarCheck;
  /** Hash matches what MCLI installed; undefined if it was not installed through MCLI. */
  hashOk?: boolean;
}

/** True if build identity `candidate` is numerically newer than `installed` (e.g. "47.4.10" > "47.2.0"). */
export function isNewerIdentity(candidate: string, installed: string): boolean {
  const a = candidate.split(/\D+/).filter(Boolean).map(Number);
  const b = installed.split(/\D+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** What is installed, from MCLI's install metadata or (as a fallback) from the jar name. */
export function installed(core: Core): InstalledInfo {
  const det = core.server.detect();
  const meta = readInstallMeta(core.cfg.serverDir);
  const provider: ProviderId | undefined = meta?.provider ?? (det && det.type !== 'neoforge' ? det.type : undefined);
  let identity = meta?.identity;
  if (!identity && det?.jar) {
    identity =
      /^paper-[\d.]+-(\d+)\.jar$/i.exec(det.jar)?.[1] ??
      (() => {
        const m = /^fabric-server-mc\.[\d.]+-loader\.([\d.]+)-launcher\.([\d.]+)\.jar$/i.exec(det.jar);
        return m ? `${m[1]}/${m[2]}` : undefined;
      })() ??
      (provider === 'vanilla' ? det.mcVersion : undefined);
  }
  return { provider, mcVersion: meta?.mcVersion ?? det?.mcVersion, identity, file: meta?.file ?? det?.jar, javaMajor: meta?.javaMajor };
}

/** Asks the provider for newer builds / Minecraft versions than the installed ones. */
export async function runUpdateCheck(core: Core): Promise<UpdateInfo> {
  try {
    const inst = installed(core);
    if (!inst.provider || !inst.mcVersion) {
      core.updateInfo = { checkedAt: Date.now(), unknown: true };
      return core.updateInfo;
    }
    const prov = core.providers[inst.provider];
    const info: UpdateInfo = { checkedAt: Date.now() };
    const plan = await prov.plan(inst.mcVersion);
    if (inst.identity && isNewerIdentity(plan.identity, inst.identity)) info.sameMc = plan;
    else if (!inst.identity) info.unknown = true;
    const versions = await prov.versions(false);
    const idx = versions.indexOf(inst.mcVersion);
    if (versions[0] && versions[0] !== inst.mcVersion && (idx === -1 || idx > 0)) info.newerMc = versions[0];
    const before = core.updateInfo;
    core.updateInfo = info;
    if (info.sameMc && before?.sameMc?.identity !== info.sameMc.identity) core.info(`Update available: ${info.sameMc.display} (see Versions tab).`);
    return info;
  } catch (err) {
    core.updateInfo = { checkedAt: Date.now(), error: (err as Error).message };
    return core.updateInfo;
  }
}

export async function installVersion(core: Core, provider: ProviderId, mcVersion: string, backupFirst: boolean): Promise<boolean> {
  try {
    core.info(`Looking up ${provider} ${mcVersion}...`);
    const plan = await core.providers[provider].plan(mcVersion);
    return await installPlan(core, plan, backupFirst);
  } catch (err) {
    core.info(`Install failed: ${(err as Error).message}`);
    return false;
  }
}

/** Installs a download plan. The Forge installer runs under a Java that fits the Minecraft version. */
export async function installPlan(core: Core, plan: DownloadPlan, backupFirst: boolean): Promise<boolean> {
  core.forgeJava = undefined;
  if (plan.kind === 'forge-installer') {
    const java = await core.ensureJava(plan.javaMajor, plan.provider);
    if (!java) {
      core.info(`Cannot run the Forge installer: ${core.problems.map((p) => p.title).join('; ')}`);
      return false;
    }
    core.forgeJava = java;
  }
  try {
    return await core.installer.install(plan, { backupFirst });
  } finally {
    core.forgeJava = undefined;
  }
}

/** Updates to the newest build; with `latest` also to the newest Minecraft version. */
export async function update(core: Core, latest: boolean): Promise<boolean> {
  const info = await core.checkUpdates();
  const inst = installed(core);
  if (info.error) {
    core.info(`Update check failed: ${info.error}`);
    return false;
  }
  if (info.unknown || !inst.provider) {
    core.info('The installed server is not tracked by MCLI. Install it from the Versions tab first.');
    return false;
  }
  if (latest && info.newerMc) return installVersion(core, inst.provider, info.newerMc, true);
  if (info.sameMc) return installPlan(core, info.sameMc, true);
  core.info(info.newerMc ? `Already on the newest build of ${inst.mcVersion}. Use ":update latest" for Minecraft ${info.newerMc}.` : 'Already up to date.');
  return true;
}

/** Deep integrity check of the launch jar, including the checksum of what MCLI downloaded. */
export async function verify(core: Core): Promise<VerifyResult | null> {
  const det = core.server.detect();
  if (!det?.jar) {
    core.info('Nothing to verify: no launch jar detected (Forge/NeoForge start through libraries).');
    return null;
  }
  core.verifying = true;
  core.emit('verify');
  try {
    const path = join(core.cfg.serverDir, det.jar);
    core.info(`Verifying ${det.jar}...`);
    const check = await deepCheckJar(path);
    const meta = readInstallMeta(core.cfg.serverDir);
    let hashOk: boolean | undefined;
    if (check.ok && meta?.sha256 && meta.file === det.jar) {
      hashOk = (await sha256File(path)) === meta.sha256;
      if (!hashOk) check.problems.push('The file differs from what MCLI downloaded (modified or replaced).');
    }
    const result: VerifyResult = { at: Date.now(), check: { ...check, ok: check.ok && hashOk !== false }, hashOk };
    core.lastVerify = result;
    if (result.check.ok) {
      core.info(`${det.jar} is intact (${check.entries} entries${hashOk ? ', checksum matches the download' : ''}).`);
      core.removeProblem('jar-broken');
    } else {
      core.info(`${det.jar} has problems: ${result.check.problems.join('; ')}`);
      core.addProblem({ id: 'jar-broken', title: `${det.jar} is broken`, advice: 'Reinstall it in the Versions tab (R = repair).', fatal: true, action: 'versions' });
    }
    return result;
  } finally {
    core.verifying = false;
    core.emit('verify');
  }
}

/** Re-downloads the currently installed version. */
export async function repair(core: Core): Promise<boolean> {
  const inst = installed(core);
  if (!inst.provider || !inst.mcVersion) {
    core.info('Cannot repair: the installed server type or version is unknown. Use the Versions tab to install one.');
    return false;
  }
  return installVersion(core, inst.provider, inst.mcVersion, false);
}
