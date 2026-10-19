// Low-level helpers for building ANSI-styled screen lines. Frame lines only contain SGR sequences.

export const RESET = '\x1b[0m';

export const theme = {
  accent: '38;5;75',
  ok: '38;5;78',
  warn: '38;5;221',
  err: '38;5;203',
  muted: '38;5;245',
  dim: '38;5;240',
  text: '38;5;252',
  bold: '1',
  selBg: '48;5;24', // selected row
  headBg: '48;5;236',
  brandBg: '48;5;31',
  tabBg: '48;5;238',
} as const;

export function paint(text: string, ...codes: string[]): string {
  return codes.length ? `\x1b[${codes.join(';')}m${text}${RESET}` : text;
}

const TOKEN = /\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu;
const SGR = /^\x1b\[[0-9;]*m$/;

/** Number of visible columns (ANSI escapes are free, every other code point counts as one). */
export function vlen(s: string): number {
  let n = 0;
  for (const m of s.matchAll(TOKEN)) if (m[0][0] !== '\x1b' || m[0].length === 1) n++;
  return n;
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/** Truncates to at most `w` visible columns, keeping styles intact. */
export function fit(s: string, w: number): string {
  if (w <= 0) return '';
  let out = '';
  let n = 0;
  let styled = false;
  for (const m of s.matchAll(TOKEN)) {
    const t = m[0];
    if (t.length > 1 && t[0] === '\x1b') {
      out += t;
      styled = true;
      continue;
    }
    if (n >= w) break;
    out += t;
    n++;
  }
  return styled ? out + RESET : out;
}

/** Truncates (with an ellipsis) or pads with spaces to exactly `w` visible columns. */
export function pad(s: string, w: number, align: 'left' | 'right' | 'center' = 'left'): string {
  const len = vlen(s);
  if (len > w) return w > 1 ? fit(s, w - 1) + '…' : fit(s, w);
  const space = w - len;
  if (align === 'right') return ' '.repeat(space) + s;
  if (align === 'center') {
    const left = Math.floor(space / 2);
    return ' '.repeat(left) + s + ' '.repeat(space - left);
  }
  return s + ' '.repeat(space);
}

/** Visible slice [from, to) of an ANSI string; the active style at `from` is re-applied. */
export function slice(s: string, from: number, to: number): string {
  let out = '';
  let n = 0;
  let active = '';
  let started = false;
  for (const m of s.matchAll(TOKEN)) {
    const t = m[0];
    if (t.length > 1 && t[0] === '\x1b') {
      if (SGR.test(t)) {
        if (t === '\x1b[0m' || t === '\x1b[m') active = '';
        else active += t;
      }
      if (started) out += t;
      continue;
    }
    if (n >= from && n < to) {
      if (!started) {
        out += active;
        started = true;
      }
      out += t;
    }
    n++;
    if (n >= to) break;
  }
  return out + (started || active ? RESET : '');
}

/** Places `over` on top of `base` at column `col` (both ANSI strings, `base` is `width` wide). */
export function overlay(base: string, over: string, col: number, width: number): string {
  const ow = vlen(over);
  return pad(slice(base, 0, col), col) + RESET + over + RESET + pad(slice(base, col + ow, width), width - col - ow);
}

export interface BoxOptions {
  title?: string;
  color?: string;
  titleRight?: string;
}

/** Draws a rounded box of exactly w x h; `lines` is the content (padded/truncated to the inner size). */
export function box(lines: string[], w: number, h: number, opts: BoxOptions = {}): string[] {
  const color = opts.color ?? theme.dim;
  const inner = Math.max(0, w - 2);
  const out: string[] = [];
  let top = '─'.repeat(inner);
  if (opts.title) {
    const title = ` ${opts.title} `;
    const right = opts.titleRight ? ` ${opts.titleRight} ` : '';
    const rest = Math.max(0, inner - 1 - vlen(title) - vlen(right));
    top = '─' + paint(title, theme.accent, theme.bold) + paint('─'.repeat(rest), color) + (right ? paint(right, theme.muted) : '');
    top = pad(top, inner);
    out.push(paint('╭', color) + top + paint('╮', color));
  } else {
    out.push(paint('╭' + top + '╮', color));
  }
  const side = paint('│', color);
  for (let i = 0; i < h - 2; i++) out.push(side + pad(lines[i] ?? '', inner) + side);
  out.push(paint('╰' + '─'.repeat(inner) + '╯', color));
  return out.slice(0, h);
}

/** Joins equally tall blocks side by side. */
export function hjoin(blocks: string[][], widths: number[], gap = 1): string[] {
  const height = Math.max(...blocks.map((b) => b.length));
  const out: string[] = [];
  for (let r = 0; r < height; r++) {
    out.push(blocks.map((b, i) => pad(b[r] ?? '', widths[i])).join(' '.repeat(gap)));
  }
  return out;
}

export function pctColor(pct: number): string {
  if (pct >= 85) return theme.err;
  if (pct >= 60) return theme.warn;
  return theme.ok;
}

/** Horizontal bar, `pct` 0..100. */
export function bar(pct: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return paint('█'.repeat(filled), pctColor(clamped)) + paint('░'.repeat(width - filled), theme.dim);
}

const SPARK = '▁▂▃▄▅▆▇█';

/** Sparkline of the last `width` values scaled to `max`. */
export function spark(values: number[], width: number, max: number, color: string = theme.accent): string {
  const tail = values.slice(-width);
  const cells = tail.map((v) => SPARK[Math.max(0, Math.min(7, Math.round((v / (max || 1)) * 7)))]);
  return paint(' '.repeat(width - cells.length) + cells.join(''), color);
}

export function fmtBytes(n: number): string {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n: number) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${p(m)}m`;
  if (m > 0) return `${m}m ${p(s % 60)}s`;
  return `${s}s`;
}

export function fmtAge(date: Date): string {
  const ms = Date.now() - date.getTime();
  return ms < 60_000 ? 'just now' : `${fmtDuration(ms)} ago`;
}

/** Applies the row highlight to a line (existing styles are dropped so the background stays uniform). */
export function highlight(line: string, w: number): string {
  return paint(pad(stripAnsi(line), w), theme.selBg, theme.bold, '38;5;255');
}
