import { statSync } from 'node:fs';
import { join } from 'node:path';
import { saveConfigValue } from '../../config';
import { quickCheckJar, type JarCheck, type JavaInfo } from '../../diagnose';
import { javaRange } from '../../java';
import { javaForMc, PROVIDER_ORDER, type DownloadPlan, type ProviderId } from '../../providers';
import { bar, box, fmtBytes, fmtAge, pad, paint, theme, vlen } from '../draw';
import type { KeyEvent, MouseEvent } from '../input';
import { confirmModal, menuModal } from '../modal';
import type { UiHost, View, ViewFrame } from '../types';

const PROVIDER_HINT: Record<ProviderId, string> = {
  paper: 'fast, plugins (recommended)',
  vanilla: 'official Mojang server',
  fabric: 'lightweight mods',
  forge: 'classic mods (1.12.2+)',
  velocity: 'proxy that joins several servers',
};

const row = (label: string, value: string) => ` ${paint(label.padEnd(10), theme.muted)}${value}`;

/** true if `a` is a lower Minecraft version than `b` (numeric comparison of dotted parts). */
function isOlder(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

export class VersionsView implements View {
  readonly id = 'versions';
  readonly title = 'Versions';
  private java: JavaInfo | null | undefined;
  private quick: { key: string; check: JarCheck } | null = null;
  private buttonRects: { from: number; to: number; key: string }[] = [];
  private lastH = 0;

  constructor(private ui: UiHost) {}

  badge(): string {
    return this.ui.core.updateInfo?.sameMc ? paint('⬆', theme.warn, theme.bold) : '';
  }

  hints(): string {
    return 'I install / switch · U update · V verify jar · R repair · J Java · E accept EULA · F refresh';
  }

  onShow(): void {
    const { core } = this.ui;
    this.java = undefined;
    if (core.cfg.java) {
      void core.javaInfo(core.cfg.java).then((j) => {
        this.java = j;
        this.ui.render();
      });
    }
    void core.java.scan().then(() => this.ui.render());
    if (!core.updateInfo || Date.now() - core.updateInfo.checkedAt > 10 * 60_000) void core.checkUpdates();
  }

  // ------------------------------------------------------------ flows

  private requireStopped(): boolean {
    if (this.ui.core.server.state !== 'stopped') {
      this.ui.toast('Stop the server first (Dashboard: X).', 'warn');
      return false;
    }
    if (this.ui.core.installer.busy) {
      this.ui.toast(`Busy: ${this.ui.core.installer.busy}`, 'warn');
      return false;
    }
    return true;
  }

  private installFlow(): void {
    if (!this.requireStopped()) return;
    const items = PROVIDER_ORDER.map((id) => ({ label: this.ui.core.providers[id].label, value: id, hint: PROVIDER_HINT[id] }));
    this.ui.modal(menuModal('Install server software', items, (id) => void this.pickVersion(id as ProviderId, false), 0,
      ['Which server software do you want?', 'The current server jar is kept in old-jars/.']));
  }

  private async pickVersion(id: ProviderId, snapshots: boolean): Promise<void> {
    const prov = this.ui.core.providers[id];
    this.ui.toast(`Loading ${prov.label} versions...`, 'info');
    let versions: string[];
    try {
      versions = await prov.versions(snapshots);
    } catch (err) {
      return this.ui.toast(`Could not load versions: ${(err as Error).message}`, 'error');
    }
    if (!versions.length) return this.ui.toast('No versions available.', 'warn');
    const items = [
      { label: snapshots ? '« hide snapshots / pre-releases' : '« include snapshots / pre-releases', value: '__toggle__' },
      ...versions.map((v, i) => ({ label: v, value: v, hint: i === 0 ? 'newest' : '' })),
    ];
    this.ui.modal(menuModal(`${prov.label} - choose a Minecraft version`, items, (v) => {
      if (v === '__toggle__') void this.pickVersion(id, !snapshots);
      else void this.lookup(id, v);
    }, 1));
  }

  private async lookup(id: ProviderId, version: string): Promise<void> {
    this.ui.toast(`Looking up ${id} ${version}...`, 'info');
    try {
      this.confirmInstall(await this.ui.core.providers[id].plan(version));
    } catch (err) {
      this.ui.toast(`Lookup failed: ${(err as Error).message}`, 'error');
    }
  }

  private confirmInstall(plan: DownloadPlan): void {
    const { core } = this.ui;
    const inst = core.installed();
    const lines = [
      paint(plan.display, theme.accent, theme.bold),
      `File     ${plan.filename}${plan.size ? ` (${fmtBytes(plan.size)})` : ''}`,
      `Source   ${new URL(plan.url).host}`,
      `Checksum ${plan.sha256 ? 'SHA-256' : plan.sha1 ? 'SHA-1' : 'none published (jar structure is still checked)'}`,
    ];
    if (plan.kind === 'forge-installer') lines.push('Runs the Forge installer (needs Java, downloads libraries, takes minutes).');
    if (plan.channel && plan.channel !== 'STABLE') lines.push(paint(`Warning: this build is on the ${plan.channel} channel (not stable).`, theme.warn));
    if (inst.mcVersion && isOlder(plan.mcVersion, inst.mcVersion)) {
      lines.push(paint(`Warning: ${plan.mcVersion} is OLDER than ${inst.mcVersion}. A world saved by a newer version may not load.`, theme.err));
    }
    if (this.java && plan.javaMajor && this.java.major < plan.javaMajor) {
      lines.push(paint(`Warning: needs Java ${plan.javaMajor}, but Java ${this.java.major} is configured.`, theme.warn));
    }
    const hasWorlds = core.backups.worldFolders().length > 0;
    const items = [
      ...(hasWorlds ? [{ label: 'Back up the world, then install', value: 'backup' }] : []),
      { label: hasWorlds ? 'Install without a backup' : 'Install', value: 'plain' },
      { label: 'Cancel', value: 'cancel' },
    ];
    this.ui.modal(menuModal('Install', items, (v) => {
      if (v === 'cancel' || !this.requireStopped()) return;
      this.ui.toast(`Installing ${plan.display}...`, 'info');
      void core.installPlan(plan, v === 'backup').then((ok) => {
        this.quick = null;
        this.ui.toast(ok ? `Installed ${plan.display}.` : 'Install failed - see the console.', ok ? 'ok' : 'error');
        if (ok && core.problems.length === 0) this.ui.toast(`Installed ${plan.display}. Start it from the Dashboard (S).`, 'ok');
      });
    }, 0, lines));
  }

  private async updateFlow(): Promise<void> {
    const { core } = this.ui;
    if (!this.requireStopped()) return;
    this.ui.toast('Checking for updates...', 'info');
    const info = await core.checkUpdates();
    const inst = core.installed();
    if (info.error) return this.ui.toast(`Update check failed: ${info.error}`, 'error');
    if (info.unknown || !inst.provider) return this.ui.toast('This server is not tracked by MCLI. Use Install (I) once to track updates.', 'warn');
    const items: { label: string; value: string; hint?: string }[] = [];
    if (info.sameMc) items.push({ label: `Update to ${info.sameMc.display}`, value: 'same', hint: 'same Minecraft version' });
    if (info.newerMc) items.push({ label: `Upgrade to Minecraft ${info.newerMc}`, value: 'newer', hint: 'newest release' });
    if (!items.length) return this.ui.toast('Everything is up to date.', 'ok');
    items.push({ label: 'Cancel', value: 'cancel' });
    this.ui.modal(menuModal('Updates', items, (v) => {
      if (v === 'same' && info.sameMc) this.confirmInstall(info.sameMc);
      else if (v === 'newer' && info.newerMc) void this.lookup(inst.provider!, info.newerMc);
    }, 0, [`Installed: ${inst.provider} ${inst.mcVersion ?? ''} ${inst.identity ? '(' + inst.identity + ')' : ''}`]));
  }

  private async javaMenu(): Promise<void> {
    const { core } = this.ui;
    this.ui.toast('Scanning for Java...', 'info');
    const installs = await core.java.scan();
    const majors = await core.java.availableMajors();
    const have = new Set(installs.map((j) => j.major));
    const items = [
      { label: 'Automatic - MCLI picks a fitting Java per server', value: 'auto', hint: core.cfg.java ? '' : '(current)' },
      ...installs.map((j) => ({
        label: `Java ${j.major} ${j.vendor} ${j.isJdk ? 'JDK' : 'JRE'}`,
        value: `use:${j.path}`,
        hint: `[${j.source}]${core.cfg.java === j.path ? ' (current)' : ''}`,
      })),
      ...majors.filter((m) => !have.has(m)).map((m) => ({ label: `Install Java ${m} (Eclipse Temurin)`, value: `install:${m}`, hint: 'download' })),
      { label: 'Rescan this computer', value: 'scan' },
    ];
    const lines = [`${installs.length} Java installation(s) found.`, core.cfg.java ? `Fixed to: ${core.cfg.java}` : 'Currently automatic.'];
    this.ui.modal(menuModal('Java', items, (v) => {
      if (v === 'auto') {
        saveConfigValue(core.cfg, 'java', '');
        this.ui.toast('Java is chosen automatically per server.', 'ok');
      } else if (v.startsWith('use:')) {
        saveConfigValue(core.cfg, 'java', v.slice(4));
        this.ui.toast(`Java fixed to ${v.slice(4)}`, 'ok');
      } else if (v.startsWith('install:')) this.ui.javaPrompt(Number(v.slice(8)));
      else void core.java.scan().then(() => this.ui.toast('Scan finished.', 'ok'));
    }, 0, lines));
  }

  private verifyFlow(): void {
    this.ui.toast('Verifying the server jar (reads every file in it)...', 'info');
    void this.ui.core.verify().then((r) => {
      if (!r) this.ui.toast('Nothing to verify (no launch jar).', 'warn');
      else this.ui.toast(r.check.ok ? 'The server jar is intact.' : `Problem: ${r.check.problems[0]}`, r.check.ok ? 'ok' : 'error');
    });
  }

  private repairFlow(): void {
    if (!this.requireStopped()) return;
    const inst = this.ui.core.installed();
    if (!inst.provider || !inst.mcVersion) return this.ui.toast('Cannot repair: installed type/version unknown. Use Install (I).', 'warn');
    this.ui.modal(confirmModal('Repair', [`Download ${inst.provider} ${inst.mcVersion} again and replace the jar?`, 'Worlds and settings are not touched.'], () => {
      this.ui.toast('Repairing...', 'info');
      void this.ui.core.repair().then((ok) => this.ui.toast(ok ? 'Repaired.' : 'Repair failed - see the console.', ok ? 'ok' : 'error'));
    }));
  }

  // ------------------------------------------------------------ input

  onKey(k: KeyEvent): boolean {
    if (k.name !== 'char') return false;
    switch (k.ch!.toLowerCase()) {
      case 'i':
        this.installFlow();
        return true;
      case 'u':
        void this.updateFlow();
        return true;
      case 'v':
        this.verifyFlow();
        return true;
      case 'r':
        this.repairFlow();
        return true;
      case 'e':
        this.ui.eulaPrompt();
        return true;
      case 'j':
        void this.javaMenu();
        return true;
      case 'f':
        this.ui.toast('Checking for updates...', 'info');
        void this.ui.core.checkUpdates();
        return true;
    }
    return false;
  }

  onMouse(e: MouseEvent, x: number, y: number): void {
    if (e.action !== 'down' || e.button !== 0 || y !== this.lastH - 1) return;
    const hit = this.buttonRects.find((r) => x >= r.from && x < r.to);
    if (hit) this.onKey({ type: 'key', name: 'char', ch: hit.key });
  }

  // ------------------------------------------------------------ rendering

  private jarCheck(file: string | undefined): JarCheck | null {
    if (!file) return null;
    const path = join(this.ui.core.cfg.serverDir, file);
    try {
      const key = `${path}:${statSync(path).mtimeMs}`;
      if (this.quick?.key !== key) this.quick = { key, check: quickCheckJar(path) };
    } catch {
      this.quick = { key: path, check: quickCheckJar(path) };
    }
    return this.quick.check;
  }

  private installedBox(w: number, h: number): string[] {
    const { core } = this.ui;
    const det = core.server.detect();
    const inst = core.installed();
    const lines: string[] = [];
    if (core.cfg.customLaunch) {
      lines.push(row('Server', paint('custom launch command from mcli.json', theme.muted)));
      return box(lines, w, h, { title: 'Installed server' });
    }
    if (!det) {
      lines.push(row('Server', paint('nothing installed - press I to install one', theme.warn, theme.bold)));
      return box(lines, w, h, { title: 'Installed server', color: theme.warn });
    }
    lines.push(row('Server', `${paint(det.type, theme.accent, theme.bold)} ${det.mcVersion ?? paint('(version unknown)', theme.muted)}`));
    lines.push(row('Build', inst.identity ? inst.identity : paint('unknown (not installed through MCLI)', theme.muted)));
    const file = det.jar ?? inst.file;
    let fileText = file ?? paint('starts through libraries (args file)', theme.muted);
    const check = this.jarCheck(det.jar);
    if (det.jar && check) fileText += paint(`  ${fmtBytes(check.size)}`, theme.muted);
    lines.push(row('File', fileText));
    if (det.jar && check) {
      const v = core.lastVerify;
      const deep = v ? `deep check ${v.check.ok ? paint('passed', theme.ok) : paint('FAILED', theme.err, theme.bold)} ${fmtAge(new Date(v.at))}` : paint('deep check not run (V)', theme.muted);
      lines.push(row('Integrity', (check.ok ? paint('✓ structure ok', theme.ok) : paint('✗ ' + check.problems[0], theme.err, theme.bold)) + paint(' · ', theme.muted) + (core.verifying ? paint('verifying...', theme.warn) : deep)));
    } else {
      lines.push(row('Integrity', paint('-', theme.muted)));
    }
    const required = inst.javaMajor ?? (det.mcVersion ? javaForMc(det.mcVersion) : undefined);
    const range = javaRange(inst.provider, required);
    let java: string;
    if (core.cfg.java) {
      if (this.java === undefined) java = paint('checking...', theme.muted);
      else if (this.java === null) java = paint('✗ configured Java not found - press J', theme.err, theme.bold);
      else if (required && this.java.major < required) java = paint(`✗ configured Java ${this.java.major}, server needs ${required}`, theme.err, theme.bold);
      else java = paint(`✓ Java ${this.java.major}`, theme.ok) + paint(' (fixed in settings)', theme.muted);
    } else if (!core.java.scanned) {
      java = paint('scanning...', theme.muted);
    } else {
      const pick = core.java.find(range.min, range.max);
      java = pick
        ? paint(`✓ Java ${pick.major} ${pick.vendor}`, theme.ok) + paint(` (automatic${required ? ', needs ' + required + (range.max ? ' exactly' : '+') : ''})`, theme.muted)
        : paint(`✗ no Java ${required ?? ''}${range.max ? ' (exactly)' : '+'} installed - press J to install it`.replace('  ', ' '), theme.err, theme.bold);
    }
    java += paint(`  ·  ${core.java.installs.length} found on this computer`, theme.dim);
    lines.push(row('Java', java));

    const u = core.updateInfo;
    let upd: string;
    if (core.installer.busy) upd = paint(core.installer.busy, theme.warn);
    else if (!u) upd = paint('checking...', theme.muted);
    else if (u.error) upd = paint(`could not check (${u.error})`, theme.muted);
    else if (u.sameMc) upd = paint(`⬆ ${u.sameMc.display}`, theme.warn, theme.bold) + paint('  press U', theme.muted);
    else if (u.unknown) upd = paint('not tracked - press I once to install through MCLI', theme.muted);
    else upd = paint('✓ newest build', theme.ok);
    if (u?.newerMc && !u.error) upd += paint(`  ·  newer Minecraft: ${u.newerMc}`, theme.muted);
    lines.push(row('Updates', upd));
    const color = check && !check.ok ? theme.err : u?.sameMc ? theme.warn : theme.dim;
    return box(lines, w, h, { title: 'Installed server', color });
  }

  private actionBar(): string {
    this.buttonRects = [];
    let x = 1;
    const defs: [string, string][] = [['I', 'Install / switch'], ['U', 'Update'], ['V', 'Verify jar'], ['R', 'Repair'], ['J', 'Java'], ['E', 'Accept EULA'], ['F', 'Refresh']];
    const parts = defs.map(([key, label]) => {
      const text = `${paint(` ${key} `, '38;5;16', theme.accent, theme.bold)} ${paint(label, theme.text)}`;
      this.buttonRects.push({ from: x, to: x + vlen(text), key: key.toLowerCase() });
      x += vlen(text) + 3;
      return text;
    });
    return ' ' + parts.join('   ');
  }

  render(w: number, h: number): ViewFrame {
    this.lastH = h;
    const { core } = this.ui;
    const topH = 9;
    const lines = this.installedBox(w, topH);
    const actH = h - topH - 2;
    const act: string[] = [];
    const inst = core.installer;
    for (const job of [inst, core.java]) {
      if (!job.busy) continue;
      act.push(` ${paint(job.busy, theme.warn, theme.bold)}`);
      if (job.progress && job.progress.total) {
        const pct = Math.round((job.progress.done / job.progress.total) * 100);
        act.push(` ${bar(pct, Math.max(10, Math.min(60, w - 14)))} ${String(pct).padStart(3)}%`);
      }
      act.push('');
    }
    const recent = core.logs.filter((e) => e.src === 'mcli').slice(-(actH - 2 - act.length));
    for (const e of recent) act.push(' ' + paint(pad(e.text, w - 4), '38;5;80'));
    lines.push(...box(act, w, Math.max(3, actH), { title: 'Activity' }));
    while (lines.length < h - 2) lines.push('');
    lines.length = h - 2;
    lines.push('');
    lines.push(this.actionBar());
    return { lines };
  }
}
