import { box, highlight, paint, pad, theme, vlen } from './draw';
import { LineEditor, type KeyEvent } from './input';

export interface MenuItem {
  label: string;
  value: string;
  hint?: string;
}

export type Modal =
  | {
      kind: 'input';
      title: string;
      label?: string;
      editor: LineEditor;
      validate?: (value: string) => string | null;
      onSubmit: (value: string) => void;
      error?: string;
    }
  | { kind: 'confirm'; title: string; lines: string[]; danger?: boolean; onYes: () => void }
  | { kind: 'menu'; title: string; items: MenuItem[]; selected: number; onPick: (value: string) => void; lines?: string[] }
  | { kind: 'message'; title: string; lines: string[] };

export interface ModalResult {
  close: boolean;
  /** Runs after the modal was closed (may open the next modal). */
  then?: () => void;
}

const KEEP: ModalResult = { close: false };

export function inputModal(title: string, initial: string, onSubmit: (v: string) => void, opts: { label?: string; validate?: (v: string) => string | null } = {}): Modal {
  return { kind: 'input', title, editor: new LineEditor(initial), onSubmit, label: opts.label, validate: opts.validate };
}

export function confirmModal(title: string, lines: string[], onYes: () => void, danger = false): Modal {
  return { kind: 'confirm', title, lines, onYes, danger };
}

export function menuModal(title: string, items: MenuItem[], onPick: (value: string) => void, selected = 0, lines?: string[]): Modal {
  return { kind: 'menu', title, items, selected, onPick, lines };
}

export function messageModal(title: string, lines: string[]): Modal {
  return { kind: 'message', title, lines };
}

export function modalKey(m: Modal, k: KeyEvent): ModalResult {
  if (k.name === 'escape' || k.name === 'ctrl-c') return { close: true };
  switch (m.kind) {
    case 'input': {
      if (k.name === 'enter') {
        const err = m.validate?.(m.editor.value) ?? null;
        if (err) {
          m.error = err;
          return KEEP;
        }
        const value = m.editor.value;
        return { close: true, then: () => m.onSubmit(value) };
      }
      m.error = undefined;
      m.editor.handle(k);
      return KEEP;
    }
    case 'confirm':
      if (k.name === 'char' && k.ch!.toLowerCase() === 'y') return { close: true, then: m.onYes };
      if (k.name === 'enter') return { close: true, then: m.onYes };
      if (k.name === 'char' && k.ch!.toLowerCase() === 'n') return { close: true };
      return KEEP;
    case 'menu': {
      if (k.name === 'up') m.selected = (m.selected + m.items.length - 1) % m.items.length;
      else if (k.name === 'down') m.selected = (m.selected + 1) % m.items.length;
      else if (k.name === 'home') m.selected = 0;
      else if (k.name === 'end') m.selected = m.items.length - 1;
      else if (k.name === 'enter') {
        const value = m.items[m.selected].value;
        return { close: true, then: () => m.onPick(value) };
      }
      return KEEP;
    }
    case 'message':
      return k.name === 'enter' ? { close: true } : KEEP;
  }
}

export interface RenderedModal {
  top: number; // 0-based row of the box
  left: number; // 0-based column of the box
  lines: string[];
  cursor?: { x: number; y: number }; // 0-based screen position
}

export function renderModal(m: Modal, cols: number, rows: number): RenderedModal {
  const content: string[] = [];
  let cursorRel: { x: number; y: number } | undefined;
  let hint = '';
  let color: string = theme.accent;
  let minWidth = 34;
  let selRow = -1;

  switch (m.kind) {
    case 'input': {
      minWidth = 50;
      if (m.label) content.push(' ' + paint(m.label, theme.muted));
      content.push('');
      const width = Math.min(cols - 8, 56) - 6;
      const v = m.editor.view(width);
      content.push(' ' + paint('› ', theme.accent) + v.text);
      cursorRel = { x: 3 + v.cursorX, y: content.length - 1 };
      content.push(m.error ? ' ' + paint(m.error, theme.err) : '');
      hint = 'Enter confirm · Esc cancel';
      break;
    }
    case 'confirm':
      color = m.danger ? theme.err : theme.warn;
      m.lines.forEach((l) => content.push(' ' + l));
      content.push('');
      content.push(' ' + paint('[Y]', m.danger ? theme.err : theme.ok, theme.bold) + ' Yes     ' + paint('[N]', theme.muted, theme.bold) + ' No');
      hint = 'Y / Enter = yes · N / Esc = no';
      break;
    case 'menu': {
      if (m.lines?.length) {
        m.lines.forEach((l) => content.push(' ' + l));
        content.push('');
      }
      const labelW = Math.max(...m.items.map((i) => vlen(i.label)));
      minWidth = Math.max(minWidth, labelW + 8);
      const max = Math.max(3, rows - 10 - content.length);
      const start = Math.max(0, Math.min(m.selected - Math.floor(max / 2), m.items.length - max));
      const shown = m.items.slice(start, start + max);
      shown.forEach((it, idx) => {
        if (start + idx === m.selected) selRow = content.length;
        content.push(` ${pad(it.label, labelW)}${it.hint ? '  ' + paint(it.hint, theme.muted) : ''}`);
      });
      hint = '↑↓ select · Enter pick · Esc cancel';
      break;
    }
    case 'message':
      m.lines.forEach((l) => content.push(' ' + l));
      hint = 'Enter close';
      break;
  }

  const textWidth = Math.max(...content.map((l) => vlen(l)), vlen(hint) + 2, vlen(m.title) + 4, minWidth);
  const width = Math.min(cols - 2, textWidth + 4);
  const height = Math.min(rows - 2, content.length + 4);
  const body = content.map((l, i) => (i === selRow ? highlight(l, width - 2) : l));
  body.push('');
  body.push(' ' + paint(hint, theme.dim));
  const lines = box(body, width, height, { title: m.title, color });
  const top = Math.max(0, Math.floor((rows - height) / 2));
  const left = Math.max(0, Math.floor((cols - width) / 2));
  return {
    top,
    left,
    lines,
    cursor: cursorRel ? { x: left + 1 + cursorRel.x, y: top + 1 + cursorRel.y } : undefined,
  };
}
