import type { LogEntry } from '../../core';
import { paint, stripAnsi, theme } from '../draw';
import { LineEditor, type KeyEvent, type MouseEvent } from '../input';
import { inputModal } from '../modal';
import type { UiHost, View, ViewFrame } from '../types';

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
const PREFIX_RE = /^((?:\[[^\]]*\]\s*){1,3}:?)(.*)$/;

function clean(text: string): string {
  return text.replace(ANSI_RE, '').replace(/\t/g, '    ').replace(CONTROL_RE, '');
}

function colorize(entry: LogEntry, text: string): string {
  if (entry.src === 'mcli') return paint(text, '38;5;80');
  const m = PREFIX_RE.exec(text);
  const prefix = m ? m[1] : '';
  const rest = m ? m[2] : text;
  const level = /\bERROR\b|\bFATAL\b/.test(prefix) || /^\s+at |Exception/.test(text) ? theme.err : /\bWARN\b/.test(prefix) ? theme.warn : '';
  let body = rest;
  if (level) body = paint(rest, level);
  else if (/ joined the game\s*$/.test(rest)) body = paint(rest, theme.ok);
  else if (/ left the game\s*$/.test(rest)) body = paint(rest, theme.warn);
  else if (/^\s*<[^>]+>/.test(rest)) body = paint(rest, '38;5;255');
  else if (/Done \(/.test(rest)) body = paint(rest, theme.ok, theme.bold);
  return (prefix ? paint(prefix, theme.dim) : '') + body;
}

function wrap(text: string, w: number): string[] {
  if (text.length <= w) return [text];
  const out: string[] = [];
  for (let p = 0; p < text.length; p += w) out.push(text.slice(p, p + w));
  return out;
}

export class ConsoleView implements View {
  readonly id = 'console';
  readonly title = 'Console';
  private editor = new LineEditor();
  private history: string[] = [];
  private historyPos = -1;
  private scroll = 0; // wrapped rows above the newest
  private filter = '';
  private width = 80;
  private unseen = 0;

  constructor(private ui: UiHost) {
    ui.core.on('log', (e: LogEntry) => {
      if (this.scroll > 0 && this.matches(e)) {
        const rows = wrap(clean(e.text), this.width).length;
        this.scroll += rows;
        this.unseen += rows;
      }
    });
  }

  hints(): string {
    return 'Enter send · ↑↓ history · PgUp/PgDn scroll · Ctrl+F filter · Ctrl+L latest · :help for MCLI commands';
  }

  onShow(): void {
    this.unseen = 0;
  }

  private matches(e: LogEntry): boolean {
    return !this.filter || e.text.toLowerCase().includes(this.filter.toLowerCase());
  }

  private visibleRows(height: number, width: number): string[] {
    const need = height + this.scroll;
    const rows: string[] = [];
    const logs = this.ui.core.logs;
    for (let i = logs.length - 1; i >= 0 && rows.length < need; i--) {
      const e = logs[i];
      if (!this.matches(e)) continue;
      const parts = wrap(clean(e.text), width);
      for (let c = parts.length - 1; c >= 0; c--) rows.push(colorize(e, parts[c]));
    }
    rows.reverse();
    const end = rows.length - this.scroll;
    if (end < height && this.scroll > 0) this.scroll = Math.max(0, rows.length - height); // scrolled past the top
    return rows.slice(Math.max(0, end - height), Math.max(0, end));
  }

  render(w: number, h: number): ViewFrame {
    this.width = w;
    const logH = h - 2;
    const rows = this.visibleRows(logH, w);
    const lines: string[] = [];
    for (let i = 0; i < logH - rows.length; i++) lines.push('');
    lines.push(...rows);

    // status line between log and input
    const parts: string[] = [];
    if (this.filter) parts.push(paint(` filter: "${this.filter}" `, '38;5;16', theme.warn));
    if (this.scroll > 0) parts.push(paint(` ↑ ${this.scroll} rows up${this.unseen ? `, ${this.unseen} new` : ''} (Ctrl+L = latest) `, '38;5;16', theme.accent));
    const info = parts.join(' ');
    lines.push(paint('─'.repeat(2), theme.dim) + info + paint('─'.repeat(Math.max(0, w - 2 - stripAnsi(info).length)), theme.dim));

    const running = this.ui.core.server.state !== 'stopped';
    const prefix = paint('❯ ', theme.accent, theme.bold);
    const field = w - 3;
    const v = this.editor.view(field);
    if (!this.editor.value && !running) {
      lines.push(prefix + paint('server stopped - type :start (or press Tab, then S on the Dashboard)', theme.dim));
    } else {
      lines.push(prefix + v.text);
    }
    return { lines, cursor: { x: 2 + (this.editor.value || running ? v.cursorX : 0), y: h - 1 } };
  }

  onKey(k: KeyEvent): boolean {
    switch (k.name) {
      case 'enter': {
        const text = this.editor.value;
        this.editor.set('');
        this.historyPos = -1;
        this.scroll = 0;
        this.unseen = 0;
        if (!text.trim()) return true;
        if (this.history[this.history.length - 1] !== text) this.history.push(text);
        this.ui.core.exec(text);
        return true;
      }
      case 'up':
        return this.browse(-1);
      case 'down':
        return this.browse(1);
      case 'pgup':
        this.scroll += 10;
        return true;
      case 'pgdn':
        this.scroll = Math.max(0, this.scroll - 10);
        if (this.scroll === 0) this.unseen = 0;
        return true;
      case 'ctrl-l':
        this.scroll = 0;
        this.unseen = 0;
        this.filter = '';
        return true;
      case 'ctrl-f':
        this.ui.modal(inputModal('Filter console', this.filter, (v) => {
          this.filter = v.trim();
          this.scroll = 0;
        }, { label: 'Show only lines containing (empty = show all):' }));
        return true;
      case 'escape':
        if (this.filter) {
          this.filter = '';
          return true;
        }
        return false;
    }
    return this.editor.handle(k);
  }

  private browse(dir: -1 | 1): boolean {
    if (!this.history.length) return true;
    if (this.historyPos === -1) {
      if (dir === 1) return true;
      this.historyPos = this.history.length - 1;
    } else {
      this.historyPos += dir;
      if (this.historyPos < 0) this.historyPos = 0;
      if (this.historyPos >= this.history.length) {
        this.historyPos = -1;
        this.editor.set('');
        return true;
      }
    }
    this.editor.set(this.history[this.historyPos]);
    return true;
  }

  onMouse(e: MouseEvent): void {
    if (e.action === 'wheel-up') this.scroll += 3;
    else if (e.action === 'wheel-down') {
      this.scroll = Math.max(0, this.scroll - 3);
      if (this.scroll === 0) this.unseen = 0;
    }
    this.ui.render();
  }
}
