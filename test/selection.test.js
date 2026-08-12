import assert from 'node:assert/strict';
import test from 'node:test';
import {
  paintInverseCells,
  sliceByCells,
  stripAnsi,
} from '../src/ui/draw.js';

test('sliceByCells extracts by display columns', () => {
  assert.equal(sliceByCells('hello world', 0, 5), 'hello');
  assert.equal(sliceByCells('hello world', 6, 11), 'world');
  assert.equal(sliceByCells('hello world', 0, 0), '');
  assert.equal(sliceByCells('hello world', 3, 3), '');
  assert.equal(sliceByCells('hello world', 6, Infinity), 'world');
});

test('sliceByCells ignores ANSI when measuring', () => {
  const styled = '\x1b[32mhello\x1b[0m world';
  assert.equal(sliceByCells(styled, 0, 5), 'hello');
  assert.equal(sliceByCells(styled, 6, 11), 'world');
});

test('sliceByCells includes whole wide glyphs that overlap the range', () => {
  // Fullwidth A is 2 cells.
  assert.equal(sliceByCells('Ａbc', 0, 1), 'Ａ');
  assert.equal(sliceByCells('Ａbc', 1, 2), 'Ａ');
  assert.equal(sliceByCells('Ａbc', 2, 3), 'b');
});

test('paintInverseCells wraps the selected cell range', () => {
  const painted = paintInverseCells('hello world', 6, 11);
  assert.equal(stripAnsi(painted), 'hello world');
  assert.match(painted, /\x1b\[7mworld\x1b\[27m/);
  assert.ok(painted.startsWith('hello '));
});

test('paintInverseCells is a no-op for empty ranges', () => {
  assert.equal(paintInverseCells('hello', 2, 2), 'hello');
  assert.equal(paintInverseCells('hello', 5, 3), 'hello');
});

test('paintInverseCells keeps surrounding ANSI and re-applies inverse after reset', () => {
  const styled = '\x1b[32mhello\x1b[0m world';
  const painted = paintInverseCells(styled, 0, 5);
  assert.equal(stripAnsi(painted), 'hello world');
  assert.match(painted, /\x1b\[7m/);
  assert.match(painted, /world/);
});
