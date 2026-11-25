import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stripAnsi } from '../src/ansi';

describe('stripAnsi', () => {
  it('removes color and cursor sequences and keeps the text', () => {
    assert.equal(stripAnsi('\x1b[93mNetBot joined the game\x1b[0m'), 'NetBot joined the game');
    assert.equal(stripAnsi('\x1b[1;38;5;80mtext\x1b[K'), 'text');
    assert.equal(stripAnsi('plain'), 'plain');
  });
});
