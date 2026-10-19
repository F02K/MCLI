import { bar, box, fmtAge, fmtBytes, fmtDuration, hjoin, pad, paint, spark, theme, vlen } from '../draw';
import type { KeyEvent, MouseEvent } from '../input';
import { confirmModal } from '../modal';
import { stateStyle } from '../state';
import type { UiHost, View, ViewFrame } from '../types';

interface Button {
  key: string;
  label: string;
  enabled: boolean;
  run: () => void;
}

const row = (label: string, value: string) => ` ${paint(label.padEnd(9), theme.muted)}${value}`;

const ACTION_HINT: Record<string, string> = {
  eula: 'E = accept EULA',
  versions: 'V = open Versions',
  settings: 'G = open Settings',
  java: 'G = open Settings',
  'java-install': 'J = install Java',
  backups: 'K = open Backups',
};

export class DashboardView implements View {
  readonly id = 'dashboard';
  readonly title = 'Dashboard';
  private buttonRects: { from: number; to: number; button: Button }[] = [];
  private lastH = 0;

  constructor(private ui: UiHost) {}

  badge(): string {
    const n = this.ui.core.problems.length;
    return n ? paint(`!${n}`, theme.err, theme.bold) : '';
  }

  hints(): string {
    const extra = this.ui.core.problems.some((p) => p.action) ? ' · E/V/G/J/K fix problems' : '';
    return `S start · X stop · R restart · B backup · C console${extra}`;
  }

  private buttons(): Button[] {
    const { core } = this.ui;
    const state = core.server.state;
    const idle = !core.installer.busy;
    return [
      { key: 'S', label: 'Start', enabled: state === 'stopped' && idle, run: () => void core.startServer() },
      { key: 'X', label: 'Stop', enabled: state === 'running' || state === 'starting', run: () => this.confirmIfPlayers('Stop the server?', () => void core.server.stop()) },
      { key: 'R', label: 'Restart', enabled: state === 'running', run: () => this.confirmIfPlayers('Restart the server?', () => void core.restartServer()) },
      { key: 'B', label: 'Backup', enabled: !core.backups.busy, run: () => void core.backups.create() },
      { key: 'C', label: 'Console', enabled: true, run: () => this.ui.show('console') },
    ];
  }

  private confirmIfPlayers(question: string, action: () => void): void {
    const n = this.ui.core.players.online.size;
    if (n === 0) return action();
    this.ui.modal(confirmModal(question, [`${n} player(s) are online.`, 'They will be disconnected.'], action, true));
  }

  onKey(k: KeyEvent): boolean {
    if (k.name !== 'char') return false;
    const c = k.ch!.toLowerCase();
    const btn = this.buttons().find((b) => b.key.toLowerCase() === c);
    if (btn) {
      if (btn.enabled) btn.run();
      else this.ui.toast(`"${btn.label}" is not available right now (server is ${this.ui.core.server.state}).`, 'warn');
      return true;
    }
    const fixes: Record<string, () => void> = {
      e: () => this.ui.eulaPrompt(),
      v: () => this.ui.show('versions'),
      g: () => this.ui.show('settings'),
      k: () => this.ui.show('backups'),
      j: () => {
        const need = this.ui.core.problems.find((p) => p.action === 'java-install' && p.javaMajor);
        if (need) this.ui.javaPrompt(need.javaMajor!, true);
        else this.ui.show('versions');
      },
    };
    if (fixes[c]) {
      fixes[c]();
      return true;
    }
    return false;
  }

  onMouse(e: MouseEvent, x: number, y: number): void {
    if (e.action !== 'down' || e.button !== 0) return;
    const hit = this.buttonRects.find((r) => x >= r.from && x < r.to && y === this.lastH - 1);
    if (hit?.button.enabled) hit.button.run();
  }

  private healthLine(): string {
    const { core } = this.ui;
    const h = core.health;
    const st = core.server.state;
    if (st === 'stopped') return paint('-', theme.muted);
    if (h.reachable) {
      return paint('✓ ', theme.ok, theme.bold) + `answers on :${h.port} · ${h.latencyMs} ms · ${h.version}`;
    }
    if (st === 'starting') return paint('… waiting for the server to come up', theme.warn);
    if (h.everReachable) return paint(`✗ not answering for ${h.failures * 5}s`, theme.err, theme.bold);
    return paint('no status reply (status disabled or custom setup)', theme.muted);
  }

  private updateLine(): string {
    const { core } = this.ui;
    const u = core.updateInfo;
    if (core.java.busy) return paint(core.java.busy, theme.warn);
    if (core.installer.busy) return paint(core.installer.busy, theme.warn);
    if (!u) return paint('checking...', theme.muted);
    if (u.error) return paint('check failed (offline?)', theme.muted);
    if (u.sameMc) return paint(`⬆ ${u.sameMc.display}`, theme.warn, theme.bold) + paint('  (Versions: U)', theme.muted);
    if (u.newerMc) return paint('✓ build current', theme.ok) + paint(` · newer Minecraft: ${u.newerMc}`, theme.muted);
    if (u.unknown) return paint('not tracked (install via Versions)', theme.muted);
    return paint('✓ up to date', theme.ok);
  }

  private serverBox(w: number, h: number): string[] {
    const { core } = this.ui;
    const s = core.server;
    const st = stateStyle(s.state);
    const inner = w - 2;
    const players = core.players.online.size;
    const max = core.players.max ?? Number(core.properties.get('max-players') ?? 0);
    const lines = [
      row('Status', paint(`${st.icon} ${st.label}`, st.color, theme.bold)),
      row('Server', core.describeServer()),
      row('Health', this.healthLine()),
      row('Uptime', s.startedAt ? fmtDuration(Date.now() - s.startedAt) : paint('-', theme.muted)),
      row('Players', `${players}${max ? ' / ' + max : ''}`),
      row('Updates', this.updateLine()),
      row('Restarts', s.restarts ? paint(`${s.restarts} crash restart(s) in a row`, theme.warn) : `0 / ${core.cfg.maxRestarts} crash restarts`),
      row('Backup', backupLine(core)),
      row('Folder', paint(core.cfg.serverDir, theme.text)),
      row('Command', paint(s.launchLine || '(not started yet)', theme.dim)),
    ];
    return box(lines.map((l) => pad(l, inner)), w, h, { title: 'Server', color: st.color });
  }

  private resourceBox(w: number, h: number): string[] {
    const { core } = this.ui;
    const m = core.metrics;
    const last = (a: number[]) => a[a.length - 1] ?? 0;
    const inner = w - 2;
    const barW = Math.max(8, Math.min(24, inner - 30));
    const sparkW = Math.max(8, Math.min(30, inner - barW - 24));
    const total = m.totalMem;
    const sysMem = last(m.sysMem);
    const procMem = last(m.procMem);
    const running = core.server.state !== 'stopped';
    const lines = [
      ` ${paint('System CPU'.padEnd(11), theme.muted)}${bar(last(m.sysCpu), barW)} ${String(last(m.sysCpu)).padStart(3)}%  ${spark(m.sysCpu, sparkW, 100)}`,
      ` ${paint('System RAM'.padEnd(11), theme.muted)}${bar(sysMem, barW)} ${String(sysMem).padStart(3)}%  ${spark(m.sysMem, sparkW, 100, theme.ok)}`,
      '',
      ` ${paint('Server RAM'.padEnd(11), theme.muted)}${running ? fmtBytes(procMem).padEnd(barW + 1) : paint('-'.padEnd(barW + 1), theme.muted)} ${running ? String(Math.round((procMem / total) * 100)).padStart(3) + '%' : '    '}  ${spark(m.procMem.map((b) => (b / total) * 100), sparkW, Math.max(5, (Math.max(...m.procMem, 0) / total) * 120), theme.ok)}`,
      ` ${paint('Server CPU'.padEnd(11), theme.muted)}${bar(last(m.procCpu), barW)} ${String(last(m.procCpu)).padStart(3)}%  ${spark(m.procCpu, sparkW, 100)}`,
      '',
      paint(` ${fmtBytes(total)} RAM installed${process.platform === 'win32' ? ' · server stats refresh every 10s' : ''}`, theme.dim),
    ];
    return box(lines, w, h, { title: 'Resources' });
  }

  private problemsBox(w: number, h: number): string[] {
    const lines: string[] = [];
    for (const p of this.ui.core.problems) {
      const label = p.action === 'java-install' && p.javaMajor ? `J = install Java ${p.javaMajor}` : p.action ? ACTION_HINT[p.action] : '';
      const hint = label ? paint(`  [${label}]`, theme.warn) : '';
      lines.push(` ${paint('✗ ' + p.title, theme.err, theme.bold)}${hint}`);
      lines.push(`   ${paint(p.advice, theme.text)}`);
    }
    return box(lines, w, h, { title: `Problems (${this.ui.core.problems.length})`, color: theme.err });
  }

  private playersBox(w: number, h: number): string[] {
    const { core } = this.ui;
    const entries = [...core.players.online.entries()];
    const lines = entries.length
      ? entries.slice(0, h - 2).map(([name, at]) => ` ${paint('●', theme.ok)} ${pad(name, 18)} ${paint(fmtDuration(Date.now() - at), theme.muted)}`)
      : [paint(' No players online', theme.muted)];
    if (entries.length > h - 2) lines[h - 3] = paint(` ... and ${entries.length - (h - 3)} more`, theme.muted);
    return box(lines, w, h, { title: `Players (${entries.length})` });
  }

  private logBox(w: number, h: number): string[] {
    const logs = this.ui.core.logs.slice(-(h - 2));
    const lines = logs.map((e) => ' ' + paint(e.text.replace(/\x1b\[[0-9;]*m/g, ''), e.src === 'mcli' ? '38;5;80' : theme.text));
    return box(lines, w, h, { title: 'Recent log' });
  }

  private actionBar(): string {
    this.buttonRects = [];
    let x = 1;
    const parts = this.buttons().map((b) => {
      const text = b.enabled
        ? `${paint(` ${b.key} `, '38;5;16', theme.accent, theme.bold)} ${paint(b.label, theme.text)}`
        : `${paint(` ${b.key} `, theme.dim, '48;5;236')} ${paint(b.label, theme.dim)}`;
      this.buttonRects.push({ from: x, to: x + vlen(text), button: b });
      x += vlen(text) + 3;
      return text;
    });
    return ' ' + parts.join('   ');
  }

  render(w: number, h: number): ViewFrame {
    this.lastH = h;
    const body = h - 2; // last row = buttons, one spacer
    const problems = this.ui.core.problems;
    const probH = problems.length ? Math.min(problems.length * 2 + 2, 8) : 0;
    let lines: string[];
    if (w >= 100) {
      const topH = Math.min(12, Math.max(10, Math.floor((body - probH) / 2)));
      const bottomH = Math.max(0, body - probH - topH);
      const lw = Math.floor((w - 1) / 2);
      const rw = w - 1 - lw;
      lines = hjoin([this.serverBox(lw, topH), this.resourceBox(rw, topH)], [lw, rw]);
      if (probH) lines.push(...this.problemsBox(w, probH));
      if (bottomH >= 4) {
        const pw = Math.min(34, Math.floor(w / 3));
        lines.push(...hjoin([this.playersBox(pw, bottomH), this.logBox(w - pw - 1, bottomH)], [pw, w - pw - 1]));
      }
    } else {
      const serverH = 12;
      const resH = 9;
      lines = [...this.serverBox(w, serverH)];
      if (probH) lines.push(...this.problemsBox(w, probH));
      if (body - lines.length >= resH) lines.push(...this.resourceBox(w, resH));
    }
    while (lines.length < body) lines.push('');
    lines.length = body;
    lines.push('');
    lines.push(this.actionBar());
    return { lines: lines.slice(0, h) };
  }
}

function backupLine(core: UiHost['core']): string {
  const b = core.backups;
  if (b.busy) return paint(b.busy, theme.warn);
  const last = b.lastBackupAt ? `last ${fmtAge(new Date(b.lastBackupAt))}` : 'none yet this session';
  const auto = core.cfg.backupIntervalMinutes > 0 ? `auto every ${core.cfg.backupIntervalMinutes} min` : 'auto backup off';
  return `${last} · ${paint(auto, theme.muted)}`;
}
