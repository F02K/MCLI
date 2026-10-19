import type { Core } from '../core';
import { VERSION } from '../version';
import { fit, fmtDuration, overlay, pad, paint, RESET, theme, vlen } from './draw';
import { parseInput, type KeyEvent, type MouseEvent } from './input';
import { confirmModal, modalKey, renderModal, type Modal } from './modal';
import { stateStyle } from './state';
import type { Term } from './term';
import type { ToastKind, UiHost, View } from './types';
import { BackupsView } from './views/backups';
import { ConsoleView } from './views/console';
import { DashboardView } from './views/dashboard';
import { HelpView } from './views/help';
import { PlayersView } from './views/players';
import { SettingsView } from './views/settings';
import { VersionsView } from './views/versions';

const MIN_COLS = 70;
const MIN_ROWS = 18;
const TOAST_MS = 4000;

const TOAST_COLOR: Record<ToastKind, string> = { info: theme.accent, ok: theme.ok, warn: theme.warn, error: theme.err };

/** Full-screen multi-view UI shell: header with tabs, active view, footer, dialogs, mouse support. */
export class Tui implements UiHost {
  private views: View[];
  private active = 0;
  private modalState: Modal | null = null;
  private toastState: { text: string; kind: ToastKind; until: number } | null = null;
  private prev: string[] = [];
  private renderQueued = false;
  private closed = false;
  private tabRects: { from: number; to: number; index: number }[] = [];
  private tick: NodeJS.Timeout | null = null;

  constructor(
    readonly core: Core,
    private term: Term,
  ) {
    this.views = [
      new DashboardView(this),
      new ConsoleView(this),
      new PlayersView(this),
      new SettingsView(this),
      new VersionsView(this),
      new BackupsView(this),
      new HelpView(this),
    ];
  }

  start(): void {
    this.term.open();
    this.term.onData((d) => this.onData(d));
    this.term.onResize(() => {
      this.prev = [];
      this.render();
    });
    for (const ev of ['log', 'state', 'players', 'backups', 'quitting', 'problems', 'health', 'installer', 'updates', 'verify', 'java']) {
      this.core.on(ev, () => this.render());
    }
    this.core.on('problem', (p: { action?: string; javaMajor?: number }) => {
      if (this.modalState) return;
      if (p.action === 'eula') this.eulaPrompt(true);
      else if (p.action === 'java-install' && p.javaMajor) this.javaPrompt(p.javaMajor, true);
    });
    this.tick = setInterval(() => this.render(), 1000);
    this.core.exit = (code) => {
      this.close();
      process.exit(code);
    };
    this.views[this.active].onShow?.();
    this.renderNow();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.tick) clearInterval(this.tick);
    this.term.close();
  }

  // ------------------------------------------------------------ UiHost

  render(): void {
    if (this.renderQueued || this.closed) return;
    this.renderQueued = true;
    setImmediate(() => {
      this.renderQueued = false;
      this.renderNow();
    });
  }

  modal(m: Modal): void {
    this.modalState = m;
    this.render();
  }

  toast(text: string, kind: ToastKind = 'info'): void {
    this.toastState = { text, kind, until: Date.now() + TOAST_MS };
    this.render();
  }

  show(viewId: string): void {
    const idx = this.views.findIndex((v) => v.id === viewId);
    if (idx >= 0) this.switchTo(idx);
  }

  eulaPrompt(startAfter = false): void {
    const lines = [
      'Minecraft servers may only run if you accept the Minecraft EULA:',
      'https://aka.ms/MinecraftEULA',
      '',
      'Answering Yes writes eula=true to eula.txt, which means',
      'that you have read and agree to it.',
    ];
    this.modal(confirmModal('Accept the Minecraft EULA?', lines, () => {
      this.core.acceptEula();
      this.toast('EULA accepted.', 'ok');
      if (startAfter) void this.core.startServer();
    }));
  }

  javaPrompt(major: number, startAfter = false): void {
    const { core } = this;
    if (core.java.busy) return this.toast(`Busy: ${core.java.busy}`, 'warn');
    this.toast(`Looking up Java ${major}...`, 'info');
    core.java
      .plan(major)
      .then((plan) => {
        const lines = [
          `Install Java ${major} (Eclipse Temurin ${plan.imageType.toUpperCase()}, ${plan.release})?`,
          '',
          `Download   ${plan.name} (${(plan.size / 1048576).toFixed(0)} MB)`,
          `Source     ${new URL(plan.url).host}, SHA-256 is verified`,
          `Install to ${core.java.dir}`,
          '',
          'Other Java installations on this computer are not changed.',
        ];
        this.modal(confirmModal('Install Java', lines, () => {
          this.toast(`Installing Java ${major}...`, 'info');
          void core.installJava(major).then((ok) => {
            this.toast(ok ? `Java ${major} installed.` : `Java ${major} could not be installed - see the console.`, ok ? 'ok' : 'error');
            if (ok && startAfter) void core.startServer();
          });
        }));
      })
      .catch((err: Error) => this.toast(`Could not look up Java ${major}: ${err.message}`, 'error'));
  }

  quit(): void {
    if (this.core.quitting) {
      void this.core.shutdown(); // second request forces
      return;
    }
    const state = this.core.server.state;
    if (state === 'stopped') {
      void this.core.shutdown();
      return;
    }
    const players = this.core.players.online.size;
    const lines = ['The server is still running' + (players ? ` with ${players} player(s) online.` : '.'), 'Stop it and exit MCLI?'];
    this.modal(confirmModal('Quit MCLI', lines, () => void this.core.shutdown(), players > 0));
  }

  // ------------------------------------------------------------ input

  private switchTo(index: number): void {
    const n = this.views.length;
    this.active = ((index % n) + n) % n;
    this.views[this.active].onShow?.();
    this.render();
  }

  private onData(data: string): void {
    for (const ev of parseInput(data)) {
      if (ev.type === 'key') this.onKey(ev);
      else this.onMouse(ev);
    }
    this.renderNow();
  }

  private onKey(k: KeyEvent): void {
    if (this.modalState) {
      const res = modalKey(this.modalState, k);
      if (res.close) {
        this.modalState = null;
        res.then?.();
      }
      return;
    }
    if (k.name === 'ctrl-c') return this.quit();
    if (k.name === 'tab') return this.switchTo(this.active + 1);
    if (k.name === 'shift-tab') return this.switchTo(this.active - 1);
    const fn = /^f([1-9])$/.exec(k.name) ?? /^alt-([1-9])$/.exec(k.name);
    if (fn && Number(fn[1]) <= this.views.length) return this.switchTo(Number(fn[1]) - 1);

    if (this.views[this.active].onKey(k)) return;
    if (k.name === 'char' && k.ch!.toLowerCase() === 'q') this.quit();
  }

  private onMouse(e: MouseEvent): void {
    if (this.modalState) return;
    if (e.action === 'down' && e.button === 0 && e.y === 2) {
      const hit = this.tabRects.find((r) => e.x - 1 >= r.from && e.x - 1 < r.to);
      if (hit) this.switchTo(hit.index);
      return;
    }
    if (e.y >= 3 && e.y <= this.term.rows - 1) this.views[this.active].onMouse?.(e, e.x - 1, e.y - 3);
  }

  // ------------------------------------------------------------ rendering

  private header(cols: number): string[] {
    const { core } = this;
    const st = stateStyle(core.server.state);
    const brand = paint(` MCLI ${VERSION} `, '38;5;255', theme.brandBg, theme.bold);
    const left = `${brand} ${paint(core.describeServer(), theme.text)}`;

    const players = core.players.online.size;
    const max = core.players.max;
    const up = core.server.startedAt ? ` · up ${fmtDuration(Date.now() - core.server.startedAt)}` : '';
    const right = `${paint(`${st.icon} ${st.label}`, st.color, theme.bold)}${paint(`  ${players}${max ? '/' + max : ''} players${up} `, theme.muted)}`;
    const row1 = pad(left, cols - vlen(right)) + right;

    this.tabRects = [];
    let x = 1; // the tab row starts with one padding column
    const tabs = this.views.map((v, i) => {
      const badge = v.badge?.() ?? '';
      const label = ` ${i + 1} ${v.title}${badge ? ' ' + badge : ''} `;
      const text = i === this.active ? paint(label, '38;5;255', theme.selBg, theme.bold) : paint(label, theme.muted);
      this.tabRects.push({ from: x, to: x + vlen(label), index: i });
      x += vlen(label) + 1;
      return text;
    });
    const row2 = pad(paint(' ', theme.headBg) + tabs.join(' '), cols);
    return [paint(pad(row1, cols), theme.headBg), paint(row2, theme.headBg)];
  }

  private footer(cols: number, hints: string): string {
    if (this.core.quitting) {
      return paint(pad(' Stopping server before exit... press Ctrl+C to force quit', cols), theme.warn, theme.bold);
    }
    if (this.toastState && Date.now() < this.toastState.until) {
      return paint(pad(` ${this.toastState.text}`, cols), TOAST_COLOR[this.toastState.kind], theme.bold);
    }
    const global = 'Tab switch · Ctrl+C quit';
    const text = ` ${hints}`;
    const gap = cols - vlen(text) - vlen(global) - 1;
    return paint(text + (gap > 0 ? ' '.repeat(gap) + global + ' ' : ''), theme.muted);
  }

  private renderNow(): void {
    if (this.closed) return;
    const cols = this.term.cols;
    const rows = this.term.rows;
    let frame: string[];
    let cursor: { x: number; y: number } | undefined;

    if (cols < MIN_COLS || rows < MIN_ROWS) {
      frame = Array.from({ length: rows }, () => '');
      const msg = `Terminal too small (${cols}x${rows}), need at least ${MIN_COLS}x${MIN_ROWS}`;
      frame[Math.floor(rows / 2)] = pad(paint(msg, theme.warn), cols, 'center');
    } else {
      const view = this.views[this.active];
      const viewH = rows - 3;
      const vf = view.render(cols, viewH);
      frame = [...this.header(cols)];
      for (let i = 0; i < viewH; i++) frame.push(pad(vf.lines[i] ?? '', cols));
      frame.push(this.footer(cols, view.hints()));
      if (vf.cursor) cursor = { x: vf.cursor.x, y: vf.cursor.y + 2 };

      if (this.modalState) {
        const m = renderModal(this.modalState, cols, rows);
        m.lines.forEach((line, i) => {
          const row = m.top + i;
          if (row < frame.length) frame[row] = overlay(frame[row], line, m.left, cols);
        });
        cursor = m.cursor;
      }
    }

    let out = '';
    const full = this.prev.length !== frame.length;
    for (let i = 0; i < frame.length; i++) {
      const line = fit(frame[i], cols);
      if (full || this.prev[i] !== line) out += `\x1b[${i + 1};1H${line}${RESET}\x1b[K`;
      this.prev[i] = line;
    }
    out += cursor ? `\x1b[${cursor.y + 1};${cursor.x + 1}H\x1b[?25h` : '\x1b[?25l';
    this.term.write(out);
  }
}
