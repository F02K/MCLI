import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bar, box, fit, fmtAge, fmtBytes, fmtDuration, hjoin, highlight, overlay, pad, paint, pctColor, RESET, slice, spark, stripAnsi, theme, vlen } from '../src/tui/draw';

const red = (s: string) => paint(s, '31');

describe('string measuring', () => {
  it('vlen ignores ANSI escapes and counts code points', () => {
    assert.equal(vlen('abc'), 3);
    assert.equal(vlen(red('abc')), 3);
    assert.equal(vlen('😀a'), 2);
    assert.equal(vlen(''), 0);
  });
  it('stripAnsi removes styles', () => {
    assert.equal(stripAnsi(red('hi') + paint('!', '1;4')), 'hi!');
  });
});

describe('fit / pad', () => {
  it('fit truncates visible text and keeps styles closed', () => {
    assert.equal(fit('abcdef', 3), 'abc');
    assert.equal(vlen(fit(red('abcdef'), 3)), 3);
    assert.ok(fit(red('abcdef'), 3).endsWith(RESET));
    assert.equal(fit('abc', 10), 'abc');
    assert.equal(fit('abc', 0), '');
  });
  it('pad aligns, pads and ellipsizes', () => {
    assert.equal(pad('ab', 5), 'ab   ');
    assert.equal(pad('ab', 5, 'right'), '   ab');
    assert.equal(pad('ab', 5, 'center'), ' ab  ');
    assert.equal(pad('abcdef', 4), 'abc…');
    assert.equal(pad('abcdef', 1), 'a');
    assert.equal(vlen(pad(red('abcdef'), 4)), 4);
  });
});

describe('slice / overlay', () => {
  it('slice cuts by visible columns and restores the active style', () => {
    const s = red('abcdef');
    assert.equal(stripAnsi(slice(s, 2, 4)), 'cd');
    assert.ok(slice(s, 2, 4).startsWith('\x1b[31m'));
    assert.equal(slice('abc', 5, 9), '');
    assert.equal(stripAnsi(slice('abcdef', 0, 3)), 'abc');
  });
  it('slice forgets styles that were reset before the cut', () => {
    const s = red('ab') + 'cd';
    assert.equal(slice(s, 2, 4).includes('\x1b[31m'), false);
  });
  it('overlay places text on top of a line', () => {
    const out = overlay('0123456789', 'XY', 3, 10);
    assert.equal(stripAnsi(out), '012XY56789');
    assert.equal(vlen(out), 10);
  });
});

describe('box / hjoin', () => {
  it('draws a titled box of exactly the requested size', () => {
    const b = box(['hello', red('red')], 20, 5, { title: 'Title', titleRight: 'right' });
    assert.equal(b.length, 5);
    assert.ok(b.every((l) => vlen(l) === 20));
    assert.match(stripAnsi(b[0]), /^╭─ Title ─+ right ╮$/);
    assert.match(stripAnsi(b[1]), /^│hello\s+│$/);
    assert.match(stripAnsi(b[4]), /^╰─+╯$/);
  });
  it('works without a title and with content longer than the box', () => {
    const b = box(['x'.repeat(50), 'y', 'z', 'w'], 12, 4);
    assert.equal(b.length, 4);
    assert.ok(b.every((l) => vlen(l) === 12));
  });
  it('hjoin merges blocks of different height', () => {
    const rows = hjoin([['a', 'b'], ['1']], [3, 3], 2);
    assert.deepEqual(rows.map(stripAnsi), ['a    1  ', 'b       ']);
  });
});

describe('widgets and formatting', () => {
  it('bar fills proportionally, clamped to 0..100', () => {
    assert.equal(stripAnsi(bar(50, 10)), '█████░░░░░');
    assert.equal(stripAnsi(bar(150, 4)), '████');
    assert.equal(stripAnsi(bar(-5, 4)), '░░░░');
  });
  it('pctColor changes with load', () => {
    assert.equal(pctColor(10), theme.ok);
    assert.equal(pctColor(70), theme.warn);
    assert.equal(pctColor(95), theme.err);
  });
  it('spark scales values and pads on the left', () => {
    const s = stripAnsi(spark([0, 50, 100], 5, 100));
    assert.equal(vlen(s), 5);
    assert.equal(s.trimStart(), '▁▅█');
    assert.equal(stripAnsi(spark([], 3, 100)), '   ');
    assert.equal(stripAnsi(spark([1, 2, 3, 4, 5, 6], 3, 6)).length, 3);
  });
  it('fmtBytes / fmtDuration / fmtAge', () => {
    assert.equal(fmtBytes(512), '512 B');
    assert.equal(fmtBytes(2048), '2 KB');
    assert.equal(fmtBytes(5 * 1048576), '5 MB');
    assert.equal(fmtBytes(3 * 1073741824), '3.0 GB');
    assert.equal(fmtDuration(5000), '5s');
    assert.equal(fmtDuration(65_000), '1m 05s');
    assert.equal(fmtDuration(3_900_000), '1h 05m');
    assert.equal(fmtDuration(200_000_000), '2d 7h');
    assert.equal(fmtAge(new Date()), 'just now');
    assert.equal(fmtAge(new Date(Date.now() - 125_000)), '2m 05s ago');
  });
  it('highlight drops inner styles and pads to the width', () => {
    const h = highlight(red('row'), 10);
    assert.equal(vlen(h), 10);
    assert.equal(stripAnsi(h), 'row       ');
  });
});
