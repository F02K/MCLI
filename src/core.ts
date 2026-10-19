import { writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { BackupManager } from './backup';
import type { Config } from './config';
import { runCommand } from './commands';
import { getJavaInfo, type JavaInfo, type Problem } from './diagnose';
import { freshHealth, healthTick, type Health } from './health';
import { Installer } from './installer';
import { readInstallMeta, writeInstallMeta } from './installmeta';
import { JavaManager } from './java';
import { Metrics } from './metrics';
import { PlayerTracker } from './players';
import { ensureJava, preflight } from './preflight';
import { Properties } from './properties';
import { createProviders, PROVIDER_ORDER, type DownloadPlan, type Endpoints, type Provider, type ProviderId } from './providers';
import { resolveJava, ServerProcess, type ServerState } from './server';
import * as updates from './updates';
import type { InstalledInfo, UpdateInfo, VerifyResult } from './updates';
import { VERSION } from './version';

export { HELP_LINES } from './commands';
export { isNewerIdentity } from './updates';
export type { Health, InstalledInfo, UpdateInfo, VerifyResult };

export interface LogEntry {
  time: number;
  text: string;
  src: 'server' | 'mcli';
}

/** Test hooks: everything defaults to the real services and timings. */
export interface CoreOptions {
  endpoints?: Endpoints;
  javaApi?: string;
  javaVerify?: (exe: string) => Promise<JavaInfo | null>;
  healthMs?: number;
  restartDelayMs?: number;
  stopTimeoutMs?: number;
  backupCheckMs?: number;
  slowStartMs?: number;
}

const MAX_LOGS = 5000;
const DEFAULT_BACKUP_CHECK_MS = 30_000;
const DEFAULT_HEALTH_MS = 5000;
const UPDATE_RECHECK_MS = 6 * 3600_000;

function clock(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * UI-independent application state and the glue between the server process, log, players, metrics,
 * backups, installer, health checks and problems. The heavier logic lives in preflight.ts, updates.ts,
 * health.ts and commands.ts and works on this object.
 * Events: 'log', 'state', 'players', 'backups', 'quitting', 'problems', 'problem' (new one),
 * 'health', 'installer', 'updates', 'verify', 'java'.
 */
export class Core extends EventEmitter {
  readonly server: ServerProcess;
  readonly players: PlayerTracker;
  readonly metrics: Metrics;
  readonly backups: BackupManager;
  readonly installer: Installer;
  readonly java: JavaManager;
  readonly providers: Record<ProviderId, Provider>;
  readonly logs: LogEntry[] = [];
  problems: Problem[] = [];
  health: Health = freshHealth();
  updateInfo: UpdateInfo | null = null;
  lastVerify: VerifyResult | null = null;
  verifying = false;
  quitting = false;
  /** Called when MCLI should terminate; the UI layer replaces it to restore the terminal first. */
  exit: (code: number) => void = (code) => process.exit(code);

  // State shared with the helper modules.
  /** @internal Java used for the Forge installer run (old Minecraft needs an exact version). */
  forgeJava: string | undefined;
  /** @internal */
  lastJavaNote = '';
  /** @internal Java requirement learned from a startup error (class file version). */
  learnedJava = 0;
  /** @internal */
  readonly healthMs: number;
  private updateCheck: Promise<UpdateInfo> | null = null;
  private retryAfterStop = false;

  constructor(
    readonly cfg: Config,
    /** @internal */
    readonly opts: CoreOptions = {},
  ) {
    super();
    this.healthMs = opts.healthMs ?? DEFAULT_HEALTH_MS;
    this.providers = createProviders(opts.endpoints);
    this.server = new ServerProcess(cfg, opts.restartDelayMs, opts.stopTimeoutMs);
    this.players = new PlayerTracker(this.server);
    this.metrics = new Metrics(this.server);
    this.backups = new BackupManager(cfg, {
      isRunning: () => this.server.state === 'running' || this.server.state === 'starting',
      isStopped: () => this.server.state === 'stopped',
      send: (c) => this.server.send(c),
      waitForLine: (re, ms) => this.waitForLine(re, ms),
    });
    this.java = new JavaManager(cfg.configDir, (t) => this.info(t), { api: opts.javaApi, verify: opts.javaVerify });
    this.java.on('change', () => this.emit('java'));
    this.installer = new Installer({
      serverDir: cfg.serverDir,
      isStopped: () => this.server.state === 'stopped',
      hasWorlds: () => this.backups.worldFolders().length > 0,
      backup: async () => (await this.backups.create()) !== null,
      javaCommand: () => this.forgeJava ?? this.server.javaPath ?? (cfg.java || resolveJava(cfg)),
      log: (t) => (t.startsWith('[forge-installer]') ? this.addLog(t, 'mcli') : this.info(t)),
      onInstalled: () => {
        this.server.detect();
        this.removeProblem('jar-broken');
        this.removeProblem('no-server');
        this.updateInfo = null;
        this.emit('state', this.server.state);
        void this.checkUpdates();
      },
    });

    this.server.on('line', (text: string) => this.addLog(text, 'server'));
    this.server.on('info', (text: string) => this.info(text));
    this.server.on('state', (s: ServerState) => {
      if (s === 'stopped' && this.retryAfterStop) {
        this.retryAfterStop = false;
        void this.startServer();
      }
      if (s === 'stopped' || s === 'starting') this.resetHealth();
      this.emit('state', s);
    });
    this.server.on('problem', (p: Problem) => this.onServerProblem(p));
    this.players.on('change', () => this.emit('players'));
    this.backups.on('info', (text: string) => this.info(text));
    this.backups.on('change', () => this.emit('backups'));
    this.installer.on('change', () => this.emit('installer'));

    this.metrics.start();
    setInterval(() => this.autoBackupTick(), opts.backupCheckMs ?? DEFAULT_BACKUP_CHECK_MS).unref();
    setInterval(() => void healthTick(this), this.healthMs).unref();
    setInterval(() => void this.checkUpdates(), UPDATE_RECHECK_MS).unref();
  }

  get properties(): Properties {
    return new Properties(this.cfg.serverDir);
  }

  /** Short description such as "paper 1.21.1". */
  describeServer(): string {
    if (this.cfg.customLaunch) return 'custom launch';
    const d = this.server.detected;
    return d ? `${d.type}${d.mcVersion ? ' ' + d.mcVersion : ''}` : 'no server detected';
  }

  // ------------------------------------------------------------ log and problems

  addLog(text: string, src: LogEntry['src']): void {
    const entry: LogEntry = { time: Date.now(), text, src };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    this.emit('log', entry);
  }

  info(text: string): void {
    this.addLog(`[${clock()}] [MCLI] ${text}`, 'mcli');
  }

  addProblem(p: Problem): void {
    if (this.problems.some((x) => x.id === p.id)) return;
    this.problems.push(p);
    this.emit('problems');
    this.emit('problem', p);
  }

  removeProblem(id: string): void {
    const before = this.problems.length;
    this.problems = this.problems.filter((p) => p.id !== id);
    if (this.problems.length !== before) this.emit('problems');
  }

  clearProblems(): void {
    if (!this.problems.length) return;
    this.problems = [];
    this.emit('problems');
  }

  /** A problem found in the server output; Java version errors teach MCLI what the server needs. */
  private onServerProblem(p: Problem): void {
    if (p.id === 'java-old' && p.javaMajor && p.javaMajor > this.learnedJava) {
      this.learnedJava = p.javaMajor;
      const meta = readInstallMeta(this.cfg.serverDir);
      if (meta) writeInstallMeta(this.cfg.serverDir, { ...meta, javaMajor: Math.max(meta.javaMajor ?? 0, p.javaMajor) });
      if (this.cfg.java) {
        p = { ...p, action: 'settings', advice: `Clear "java" in Settings > MCLI so MCLI can use or install Java ${p.javaMajor} automatically.` };
      } else if (this.java.find(p.javaMajor)) {
        this.info(`The server needs Java ${p.javaMajor}, which is installed - restarting with it.`);
        this.retryAfterStop = true;
        return;
      }
    }
    this.addProblem(p);
  }

  private resetHealth(): void {
    this.health = freshHealth();
    this.removeProblem('not-responding');
    this.removeProblem('slow-start');
    this.emit('health');
  }

  // ------------------------------------------------------------ starting, Java, EULA

  /** Checks everything that can be checked before launching; adds Problems and returns false on failure. */
  preflight(): Promise<boolean> {
    return preflight(this);
  }

  ensureJava(required: number | undefined, provider: string | undefined): Promise<string | null> {
    return ensureJava(this, required, provider);
  }

  /** Runs `java -version` for one executable (replaceable in tests). */
  javaInfo(exe: string): Promise<JavaInfo | null> {
    return (this.opts.javaVerify ?? getJavaInfo)(exe);
  }

  /** The java executable the server would use right now (for display). */
  currentJava(): string {
    return this.cfg.java || this.server.javaPath || resolveJava(this.cfg);
  }

  /** Installs a Java version and clears the related problems. */
  async installJava(major: number): Promise<boolean> {
    const result = await this.java.install(major);
    if (result) {
      this.removeProblem('java-install');
      this.removeProblem('java-missing');
      this.removeProblem('java-old');
    }
    return result !== null;
  }

  async startServer(): Promise<void> {
    if (this.server.state !== 'stopped') {
      this.info(`Server is already ${this.server.state}.`);
      return;
    }
    if (this.installer.busy) {
      this.info(`Wait for the installer to finish: ${this.installer.busy}`);
      return;
    }
    if (!(await this.preflight())) {
      this.info(`Not starting: ${this.problems.map((p) => p.title).join('; ')}.`);
      return;
    }
    this.server.start();
  }

  async restartServer(): Promise<void> {
    await this.server.stop();
    await this.startServer();
  }

  acceptEula(): void {
    const text =
      '#By changing the setting below to TRUE you are indicating your agreement to the Minecraft EULA (https://aka.ms/MinecraftEULA).\n' +
      `#${new Date().toString()}\neula=true\n`;
    writeFileSync(join(this.cfg.serverDir, 'eula.txt'), text);
    this.removeProblem('eula');
    this.info('EULA accepted (eula.txt written).');
  }

  // ------------------------------------------------------------ installed software and updates

  installed(): InstalledInfo {
    return updates.installed(this);
  }

  /** Checks for updates; callers that arrive while a check runs wait for that same check. */
  checkUpdates(): Promise<UpdateInfo> {
    if (!this.updateCheck) {
      this.emit('updates');
      this.updateCheck = updates.runUpdateCheck(this).finally(() => {
        this.updateCheck = null;
        this.emit('updates');
      });
    }
    return this.updateCheck;
  }

  provider(id: string): Provider | undefined {
    return (PROVIDER_ORDER as string[]).includes(id) ? this.providers[id as ProviderId] : undefined;
  }

  installVersion(provider: ProviderId, mcVersion: string, backupFirst = true): Promise<boolean> {
    return updates.installVersion(this, provider, mcVersion, backupFirst);
  }

  installPlan(plan: DownloadPlan, backupFirst: boolean): Promise<boolean> {
    return updates.installPlan(this, plan, backupFirst);
  }

  update(latest = false): Promise<boolean> {
    return updates.update(this, latest);
  }

  verify(): Promise<VerifyResult | null> {
    return updates.verify(this);
  }

  repair(): Promise<boolean> {
    return updates.repair(this);
  }

  // ------------------------------------------------------------ misc

  /** Resolves true when a server line matching `re` shows up within the timeout. */
  waitForLine(re: RegExp, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const onLine = (line: string) => {
        if (re.test(line)) done(true);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.server.off('line', onLine);
        this.server.off('state', onState);
        resolve(ok);
      };
      const onState = (s: ServerState) => {
        if (s === 'stopped') done(false);
      };
      this.server.on('line', onLine);
      this.server.on('state', onState);
    });
  }

  private autoBackupTick(): void {
    const minutes = this.cfg.backupIntervalMinutes;
    if (minutes <= 0 || this.server.state !== 'running' || this.backups.busy) return;
    const last = this.backups.lastBackupAt ?? this.server.startedAt ?? Date.now();
    if (Date.now() - last >= minutes * 60_000) {
      this.info(`Automatic backup (every ${minutes} min)`);
      void this.backups.create();
    }
  }

  /** Handles a line typed by the user: ":command" for MCLI, anything else goes to the server console. */
  exec(text: string): void {
    if (text.startsWith(':')) runCommand(this, text.slice(1).trim());
    else if (this.server.send(text)) this.addLog(`[${clock()}] › ${text}`, 'mcli');
    else this.info('Server is not running. Type :start.');
  }

  /** Graceful quit: stops the server first. A second call forces the exit. */
  async shutdown(): Promise<void> {
    if (this.quitting) {
      this.info('Forcing exit.');
      this.server.kill();
      this.exit(1);
      return;
    }
    this.quitting = true;
    this.emit('quitting');
    if (this.server.state !== 'stopped') this.info('Stopping server before exit... (Ctrl+C again to force)');
    await this.server.stop();
    this.metrics.stop();
    this.exit(0);
  }

  banner(): void {
    this.server.detect();
    this.info(`MCLI ${VERSION}`);
    this.info(`Server folder: ${this.cfg.serverDir}`);
    this.info(this.cfg.customLaunch ? 'Using custom launch command from config.' : `Detected: ${this.describeServer()}.`);
    this.info('Type :start to launch the server, :help for all commands.');
    void this.java.scan();
    setTimeout(() => void this.checkUpdates(), 2000).unref();
  }
}
