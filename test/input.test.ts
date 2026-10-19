import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LineEditor, parseInput, type InputEvent, type KeyEvent } from '../src/tui/input';

const names = (data: string): string[] => parseInput(data).map((e) => (e.type === 'key' ? (e.name === 'char' ? `'${e.ch}'` : e.name) : `mouse:${e.action}`));
const key = (name: string, ch?: string): KeyEvent => ({ type: 'key', name, ch });

describe('parseInput', () => {
  it('splits plain text into characters (paste)', () => {
    assert.deepEqual(names('abc'), ["'a'", "'b'", "'c'"]);
    assert.deepEqual(names('äö€'), ["'ä'", "'ö'", "'€'"]);
    assert.deepEqual(names('😀'), ["'😀'"]);
  });

  it('recognises control keys', () => {
    assert.deepEqual(names('\r\n\t\x7f\b'), ['enter', 'enter', 'tab', 'backspace', 'backspace']);
    assert.deepEqual(names('\x03\x01\x05\x15\x0b\x17\x0c\x06'), ['ctrl-c', 'ctrl-a', 'ctrl-e', 'ctrl-u', 'ctrl-k', 'ctrl-w', 'ctrl-l', 'ctrl-f']);
  });

  it('recognises arrows, home/end, paging and delete in all common encodings', () => {
    assert.deepEqual(names('\x1b[A\x1b[B\x1b[C\x1b[D'), ['up', 'down', 'right', 'left']);
    assert.deepEqual(names('\x1bOA\x1bOB\x1bOC\x1bOD'), ['up', 'down', 'right', 'left']);
    assert.deepEqual(names('\x1b[H\x1b[F\x1b[1~\x1b[4~\x1b[7~\x1b[8~\x1bOH\x1bOF'), ['home', 'end', 'home', 'end', 'home', 'end', 'home', 'end']);
    assert.deepEqual(names('\x1b[5~\x1b[6~\x1b[3~\x1b[2~'), ['pgup', 'pgdn', 'delete', 'insert']);
    assert.deepEqual(names('\x1b[Z'), ['shift-tab']);
  });

  it('recognises function keys from xterm, SS3, and the Windows console', () => {
    assert.deepEqual(names('\x1bOP\x1bOQ\x1bOR\x1bOS'), ['f1', 'f2', 'f3', 'f4']);
    assert.deepEqual(names('\x1b[11~\x1b[12~\x1b[13~\x1b[14~\x1b[15~'), ['f1', 'f2', 'f3', 'f4', 'f5']);
    assert.deepEqual(names('\x1b[[A\x1b[[B\x1b[[C\x1b[[D\x1b[[E'), ['f1', 'f2', 'f3', 'f4', 'f5']);
    assert.deepEqual(names('\x1b[17~\x1b[18~\x1b[19~\x1b[20~\x1b[21~\x1b[23~\x1b[24~'), ['f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12']);
  });

  it('applies modifiers to arrows', () => {
    assert.deepEqual(names('\x1b[1;5C\x1b[1;5D\x1b[1;2A\x1b[1;3B'), ['ctrl-right', 'ctrl-left', 'shift-up', 'alt-down']);
  });

  it('treats ESC+char as Alt and a lone ESC as escape', () => {
    assert.deepEqual(names('\x1b1\x1bx'), ['alt-1', 'alt-x']);
    assert.deepEqual(names('\x1b'), ['escape']);
  });

  it('drops unknown sequences without losing the following keys', () => {
    assert.deepEqual(names('\x1b[99~a'), ["'a'"]);
    assert.deepEqual(names('\x1bOZa'), ["'a'"]);
  });

  it('parses SGR mouse events', () => {
    const [down, up, wheelUp, wheelDown, move] = parseInput('\x1b[<0;10;5M\x1b[<0;10;5m\x1b[<64;3;4M\x1b[<65;3;4M\x1b[<35;7;8M') as Extract<InputEvent, { type: 'mouse' }>[];
    assert.deepEqual([down.action, down.x, down.y, down.button], ['down', 10, 5, 0]);
    assert.equal(up.action, 'up');
    assert.equal(wheelUp.action, 'wheel-up');
    assert.equal(wheelDown.action, 'wheel-down');
    assert.equal(move.action, 'move');
  });

  it('handles mixed input in one chunk', () => {
    assert.deepEqual(names('ab\x1b[A\r'), ["'a'", "'b'", 'up', 'enter']);
  });
});

describe('LineEditor', () => {
  const type = (ed: LineEditor, text: string) => [...text].forEach((ch) => ed.handle(key('char', ch)));

  it('inserts at the cursor and moves with the arrows', () => {
    const ed = new LineEditor();
    type(ed, 'helo');
    ed.handle(key('left'));
    ed.handle(key('char', 'l'));
    assert.equal(ed.value, 'hello');
    assert.equal(ed.cursor, 4);
    ed.handle(key('right'));
    ed.handle(key('right'));
    assert.equal(ed.cursor, 5);
    ed.handle(key('home'));
    assert.equal(ed.cursor, 0);
    ed.handle(key('left'));
    assert.equal(ed.cursor, 0);
    ed.handle(key('end'));
    assert.equal(ed.cursor, 5);
  });

  it('deletes with backspace and delete', () => {
    const ed = new LineEditor('abc');
    ed.handle(key('backspace'));
    assert.equal(ed.value, 'ab');
    ed.handle(key('home'));
    ed.handle(key('backspace'));
    assert.equal(ed.value, 'ab');
    ed.handle(key('delete'));
    assert.equal(ed.value, 'b');
  });

  it('supports kill commands and word jumps', () => {
    const ed = new LineEditor('say hello world');
    ed.handle(key('ctrl-w'));
    assert.equal(ed.value, 'say hello ');
    ed.handle(key('ctrl-left'));
    assert.equal(ed.cursor, 4);
    ed.handle(key('ctrl-right'));
    assert.equal(ed.cursor, 9);
    ed.handle(key('ctrl-a'));
    ed.handle(key('ctrl-k'));
    assert.equal(ed.value, '');
    ed.set('xyz');
    ed.handle(key('left'));
    ed.handle(key('ctrl-u'));
    assert.deepEqual([ed.value, ed.cursor], ['z', 0]);
    ed.handle(key('ctrl-e'));
    assert.equal(ed.cursor, 1);
    ed.set('a b');
    ed.handle(key('home'));
    ed.handle(key('ctrl-right'));
    assert.equal(ed.cursor, 1);
  });

  it('reports whether it consumed a key', () => {
    const ed = new LineEditor();
    assert.equal(ed.handle(key('enter')), false);
    assert.equal(ed.handle(key('f1')), false);
    assert.equal(ed.handle(key('char', 'x')), true);
  });

  it('scrolls the visible window with the cursor', () => {
    const ed = new LineEditor('0123456789');
    assert.deepEqual(ed.view(20), { text: '0123456789', cursorX: 10 });
    const narrow = ed.view(5);
    assert.equal(narrow.text.length <= 5, true);
    assert.equal(narrow.cursorX, 4);
    ed.handle(key('home'));
    assert.deepEqual(ed.view(5), { text: '01234', cursorX: 0 });
  });
});
