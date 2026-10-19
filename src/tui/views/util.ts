import { highlight, pad, paint, theme } from '../draw';
import type { KeyEvent } from '../input';

/** Selection + scroll state for a vertical list. */
export class ListState {
  selected = 0;
  offset = 0;

  clamp(count: number): void {
    this.selected = Math.max(0, Math.min(count - 1, this.selected));
    if (count === 0) this.selected = 0;
  }

  /** Handles navigation keys; returns true if consumed. */
  handle(k: KeyEvent, count: number, page: number): boolean {
    switch (k.name) {
      case 'up':
        this.selected--;
        break;
      case 'down':
        this.selected++;
        break;
      case 'pgup':
        this.selected -= page;
        break;
      case 'pgdn':
        this.selected += page;
        break;
      case 'home':
        this.selected = 0;
        break;
      case 'end':
        this.selected = count - 1;
        break;
      default:
        return false;
    }
    this.clamp(count);
    return true;
  }

  wheel(dir: 1 | -1, count: number): void {
    this.selected += dir * 3;
    this.clamp(count);
  }

  /** Adjusts the scroll offset so the selection is visible and returns the first visible index. */
  window(height: number, count: number): number {
    this.clamp(count);
    if (this.selected < this.offset) this.offset = this.selected;
    if (this.selected >= this.offset + height) this.offset = this.selected - height + 1;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, count - height)));
    return this.offset;
  }
}

export interface Column {
  title: string;
  width: number; // 0 = take the remaining space
  align?: 'left' | 'right';
}

/** Renders a table (header + rows) of `h` lines with the selected row highlighted. */
export function renderTable(cols: Column[], rows: string[][], list: ListState, w: number, h: number, empty: string): string[] {
  const fixed = cols.reduce((n, c) => n + c.width + 1, 1);
  const flex = Math.max(8, w - fixed);
  const widths = cols.map((c) => (c.width === 0 ? flex : c.width));
  const line = (cells: string[]) => ' ' + cols.map((c, i) => pad(cells[i] ?? '', widths[i], c.align ?? 'left')).join(' ');
  const out: string[] = [paint(pad(line(cols.map((c) => c.title)), w), theme.muted, theme.bold)];
  const bodyH = h - 1;
  if (!rows.length) {
    out.push('');
    out.push(paint(pad(` ${empty}`, w), theme.muted));
    return out;
  }
  const start = list.window(bodyH, rows.length);
  for (let i = start; i < Math.min(rows.length, start + bodyH); i++) {
    const text = line(rows[i]);
    out.push(i === list.selected ? highlight(text, w) : text);
  }
  return out;
}
