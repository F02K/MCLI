import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config';
import { detectServer, type DetectedServer } from './detect';
import { stripAnsi } from './ansi';
import { diagnoseLine, type Problem } from './diagnose';

export type ServerState = 'stopped' | 'starting' | 'running' | 'stopping';

const DEFAULT_STOP_TIMEOUT_MS = 30_000;
const DEFAULT_RESTART_DELAY_MS = 5_000;
const STABLE_AFTER_MS = 10 * 60_000;
const READY_PATTERN = /Done \([\d.,]+s\)!/; // Paper: "... For help", Velocity: just "Done (0.5s)!"

/** The java executable to use: config, then JAVA_HOME, then PATH. */
export function resolveJava(cfg: Config): string {
  if (cfg.java) return cfg.java;
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const home = process.env.JAVA_HOME;
  if (home && existsSync(join(home, 'bin', exe))) return join(home, 'bin', exe);
  return 'java';
}

/**
 * Supervises the Minecraft server child process.
 * Events: 'line' (text), 'state' (ServerState), 'info' (text from MCLI itself),
 * 'problem' (Problem found in the output or at launch).
 */
export class ServerProcess extends EventEmitter {
  state: ServerState = 'stopped';
  detected: DetectedServer | null = null;
  /** Epoch ms when the current process was spawned. */
  startedAt: number | null = null;
  /** The command line of the last launch, for display. */
  launchLine = '';
  /** Problems recognised in the output of the current/last run. */
  problems: Problem[] = [];
  /** Java chosen automatically by MCLI (used when cfg.java is empty). */
  javaPath: string | undefined;
  /** True once the current process reported readiness (or answered a status ping). */
  everReady = false;
  private child: ChildProcess | null = null;
  private stopRequested = false;
  /** Consecutive crash restarts so far. */
  restarts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;

  constructor(
    private cfg: Config,
    private restartDelayMs = DEFAULT_RESTART_DELAY_MS,
    private stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  ) {
    super();
  }

  private setState(state: ServerState): void {
    this.state = state;
    this.emit('state', state);
  }

  private info(text: string): void {
    this.emit('info', text);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Re-runs server detection. Returns a short description or null. */
  detect(): DetectedServer | null {
    this.detected = detectServer(this.cfg.serverDir);
    return this.detected;
  }

  private buildCommand(): { command: string; args: string[] } | null {
    if (this.cfg.customLaunch) return this.cfg.customLaunch;
    const det = this.detect();
    if (!det) return null;
    const memory: string[] = [];
    if (!det.launchArgs[0]?.startsWith('@')) {
      if (this.cfg.minMemory) memory.push(`-Xms${this.cfg.minMemory}`);
      if (this.cfg.maxMemory) memory.push(`-Xmx${this.cfg.maxMemory}`);
    }
    return { command: this.cfg.java || this.javaPath || resolveJava(this.cfg), args: [...memory, ...det.launchArgs] };
  }

  start(): void {
    if (this.state !== 'stopped') {
      this.info(`Server is already ${this.state}.`);
      return;
    }
    this.cancelRestart();
    const launch = this.buildCommand();
    if (!launch) {
      this.info(`No Minecraft server found in ${this.cfg.serverDir}.`);
      return;
    }
    this.stopRequested = false;
    this.problems = [];
    this.everReady = false;
    this.launchLine = `${launch.command} ${launch.args.join(' ')}`;
    this.startedAt = Date.now();
    this.setState('starting');
    this.info(`Starting: ${this.launchLine}`);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: this.cfg.serverDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      // spawn throws synchronously for files that cannot be executed
      this.info(`Failed to launch "${launch.command}": ${(err as Error).message}`);
      this.addProblem({
        id: 'java-broken',
        title: `"${launch.command}" cannot be executed`,
        advice: 'Check the "java" setting in Settings > MCLI, or clear it so MCLI picks a Java automatically.',
        fatal: true,
        action: 'settings',
      });
      this.startedAt = null;
      this.setState('stopped');
      return;
    }
    this.child = child;
    this.pipeLines(child.stdout);
    this.pipeLines(child.stderr);
    child.stdin.on('error', () => {});
    child.on('error', (err) => {
      this.info(`Failed to launch "${launch.command}": ${err.message}`);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.addProblem({
          id: 'java-missing',
          title: 'Java was not found',
          advice: 'Install Java, or set the path to java.exe / java in Settings > MCLI ("java").',
          fatal: true,
          action: 'java',
        });
      }
      this.handleExit(child, null);
    });
    child.on('exit', (code) => this.handleExit(child, code));
  }

  private pipeLines(stream: NodeJS.ReadableStream): void {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      const parts = (rest + chunk).split(/\r?\n/);
      rest = parts.pop() ?? '';
      for (const line of parts) this.handleLine(line);
    });
    stream.on('end', () => {
      if (rest) this.handleLine(rest);
      rest = '';
    });
  }

  private addProblem(problem: Problem): void {
    if (this.problems.some((p) => p.id === problem.id)) return;
    this.problems.push(problem);
    this.emit('problem', problem);
  }

  private handleLine(line: string): void {
    this.emit('line', line);
    const plain = stripAnsi(line);
    const problem = diagnoseLine(plain);
    if (problem) this.addProblem(problem);
    if (this.state === 'starting' && READY_PATTERN.test(plain)) this.markRunning();
  }

  /** Marks a starting server as running (log says "Done", or it answered a status ping). */
  markRunning(): void {
    if (this.state !== 'starting') return;
    this.everReady = true;
    this.setState('running');
    this.stableTimer = setTimeout(() => (this.restarts = 0), STABLE_AFTER_MS);
  }

  private handleExit(child: ChildProcess, code: number | null): void {
    if (this.child !== child) return;
    this.child = null;
    if (this.killTimer) clearTimeout(this.killTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    const requested = this.stopRequested;
    this.startedAt = null;
    this.setState('stopped');
    this.info(`Server exited${code === null ? '' : ` with code ${code}`}.`);
    if (requested || code === 0) return;
    if (!this.everReady && !this.problems.length) {
      this.addProblem({
        id: 'startup-failed',
        title: 'The server stopped before it finished starting',
        advice: 'Read the last lines of the console for the cause.',
        fatal: false,
      });
    }
    if (this.problems.some((p) => p.fatal)) {
      this.info('Not restarting automatically: the problem needs your attention (see Dashboard).');
      return;
    }

    if (!this.cfg.autoRestart) return;
    if (this.restarts >= this.cfg.maxRestarts) {
      this.info(`Server crashed ${this.restarts} times in a row, auto-restart disabled until next manual start.`);
      return;
    }
    this.restarts++;
    this.info(`Server crashed, restarting in ${this.restartDelayMs / 1000}s (attempt ${this.restarts}/${this.cfg.maxRestarts}).`);
    this.restartTimer = setTimeout(() => this.start(), this.restartDelayMs);
  }

  private cancelRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  /** Sends a console command to the server. Returns false if it is not running. */
  send(command: string): boolean {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) return false;
    stdin.write(command + '\n');
    return true;
  }

  /** Graceful stop; resolves once the process has exited. */
  stop(): Promise<void> {
    this.cancelRestart();
    this.restarts = 0;
    const child = this.child;
    if (!child) return Promise.resolve();
    this.stopRequested = true;
    this.setState('stopping');
    this.send('stop');
    this.killTimer = setTimeout(() => {
      this.info('Server did not stop in time, killing it.');
      child.kill();
    }, this.stopTimeoutMs);
    return new Promise((resolve) => child.once('exit', () => resolve()));
  }

  async restart(): Promise<void> {
    await this.stop();
    this.start();
  }

  /** Immediately kills the process (used on forced quit). */
  kill(): void {
    this.cancelRestart();
    this.stopRequested = true;
    this.child?.kill();
  }
}
