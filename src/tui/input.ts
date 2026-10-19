export interface KeyEvent {
  type: 'key';
  /** 'char' for printable input, otherwise e.g. 'enter', 'up', 'ctrl-c', 'alt-1', 'f2', 'shift-tab'. */
  name: string;
  /** Set when name === 'char'. */
  ch?: string;
}

export interface MouseEvent {
  type: 'mouse';
  action: 'down' | 'up' | 'move' | 'wheel-up' | 'wheel-down';
  button: number;
  /** 1-based terminal coordinates. */
  x: number;
  y: number;
}

export type InputEvent = KeyEvent | MouseEvent;

const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/y;
const CSI_RE = /\x1b\[([0-9;]*)([A-Za-z~])/y;
const LIBUV_FKEY_RE = /\x1b\[\[([A-E])/y; // Windows console: F1-F5
const SS3_RE = /\x1bO([A-Za-z])/y;

const CSI_LETTER: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'shift-tab', P: 'f1', Q: 'f2', R: 'f3', S: 'f4' };
const SS3_LETTER: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', P: 'f1', Q: 'f2', R: 'f3', S: 'f4' };
const CSI_TILDE: Record<number, string> = {
  1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pgup', 6: 'pgdn', 7: 'home', 8: 'end',
  11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12',
};

function key(name: string, ch?: string): KeyEvent {
  return ch === undefined ? { type: 'key', name } : { type: 'key', name, ch };
}

function withModifier(name: string, mod: number | undefined): string {
  if (!mod || mod === 1 || name === 'shift-tab') return name;
  const bits = mod - 1;
  const prefix = [bits & 4 ? 'ctrl' : '', bits & 2 ? 'alt' : '', bits & 1 ? 'shift' : ''].filter(Boolean).join('-');
  return prefix ? `${prefix}-${name}` : name;
}

/** Splits raw terminal input into key and mouse events. */
export function parseInput(data: string): InputEvent[] {
  const out: InputEvent[] = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i];
    if (c === '\x1b') {
      let m: RegExpExecArray | null;
      MOUSE_RE.lastIndex = i;
      if ((m = MOUSE_RE.exec(data))) {
        const b = Number(m[1]);
        const x = Number(m[2]);
        const y = Number(m[3]);
        let action: MouseEvent['action'];
        if (b & 64) action = b & 1 ? 'wheel-down' : 'wheel-up';
        else if (b & 32) action = 'move';
        else action = m[4] === 'M' ? 'down' : 'up';
        out.push({ type: 'mouse', action, button: b & 3, x, y });
        i += m[0].length;
        continue;
      }
      LIBUV_FKEY_RE.lastIndex = i;
      if ((m = LIBUV_FKEY_RE.exec(data))) {
        out.push(key('f' + (m[1].charCodeAt(0) - 64)));
        i += m[0].length;
        continue;
      }
      CSI_RE.lastIndex = i;
      if ((m = CSI_RE.exec(data))) {
        const parts = m[1].split(';').map((p) => (p === '' ? undefined : Number(p)));
        const name = m[2] === '~' ? CSI_TILDE[parts[0] ?? -1] : CSI_LETTER[m[2]];
        if (name) out.push(key(withModifier(name, parts[1])));
        i += m[0].length;
        continue;
      }
      SS3_RE.lastIndex = i;
      if ((m = SS3_RE.exec(data))) {
        const name = SS3_LETTER[m[1]];
        if (name) out.push(key(name));
        i += m[0].length;
        continue;
      }
      if (i + 1 < data.length) {
        const next = String.fromCodePoint(data.codePointAt(i + 1)!);
        out.push(key(`alt-${next.toLowerCase()}`));
        i += 1 + next.length;
        continue;
      }
      out.push(key('escape'));
      i++;
      continue;
    }
    const cp = data.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (ch === '\r' || ch === '\n') out.push(key('enter'));
    else if (ch === '\t') out.push(key('tab'));
    else if (ch === '\x7f' || ch === '\b') out.push(key('backspace'));
    else if (cp >= 1 && cp <= 26) out.push(key(`ctrl-${String.fromCharCode(cp + 96)}`));
    else if (cp >= 32) out.push(key('char', ch));
  }
  return out;
}

/** Single-line text editing state shared by the console input and dialogs. */
export class LineEditor {
  value: string;
  cursor: number;

  constructor(initial = '') {
    this.value = initial;
    this.cursor = initial.length;
  }

  /** Handles editing keys. Returns true if the key was consumed. */
  handle(k: KeyEvent): boolean {
    const v = this.value;
    const c = this.cursor;
    switch (k.name) {
      case 'char':
        this.value = v.slice(0, c) + k.ch + v.slice(c);
        this.cursor += k.ch!.length;
        return true;
      case 'backspace':
        if (c > 0) {
          this.value = v.slice(0, c - 1) + v.slice(c);
          this.cursor--;
        }
        return true;
      case 'delete':
        this.value = v.slice(0, c) + v.slice(c + 1);
        return true;
      case 'left':
        this.cursor = Math.max(0, c - 1);
        return true;
      case 'right':
        this.cursor = Math.min(v.length, c + 1);
        return true;
      case 'home':
      case 'ctrl-a':
        this.cursor = 0;
        return true;
      case 'end':
      case 'ctrl-e':
        this.cursor = v.length;
        return true;
      case 'ctrl-u':
        this.value = v.slice(c);
        this.cursor = 0;
        return true;
      case 'ctrl-k':
        this.value = v.slice(0, c);
        return true;
      case 'ctrl-w': {
        const before = v.slice(0, c).replace(/\S+\s*$/, '');
        this.value = before + v.slice(c);
        this.cursor = before.length;
        return true;
      }
      case 'ctrl-left': {
        const m = /\S+\s*$/.exec(v.slice(0, c));
        this.cursor = m ? c - m[0].length : 0;
        return true;
      }
      case 'ctrl-right': {
        const m = /^\s*\S+/.exec(v.slice(c));
        this.cursor = m ? c + m[0].length : v.length;
        return true;
      }
    }
    return false;
  }

  set(value: string): void {
    this.value = value;
    this.cursor = value.length;
  }

  /** The visible part of the text for a field `width` wide and the cursor column inside it. */
  view(width: number): { text: string; cursorX: number } {
    const start = Math.max(0, this.cursor - width + 1);
    return { text: this.value.slice(start, start + width), cursorX: this.cursor - start };
  }
}
