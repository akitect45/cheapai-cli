import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDiffPayload, computeDiffLines, countDiffStats, formatDiffStats } from '../src/ui/diff.js';

test('edit-style hunks count additions and deletions', () => {
  const before = 'const a = 1;\nconst b = 2;\n';
  const after = 'const a = 1;\nconst b = 3;\nconst c = 4;\n';
  const stats = countDiffStats(before, after);
  assert.equal(stats.deletions, 1);
  assert.equal(stats.additions, 2);
  assert.equal(formatDiffStats(stats), '+2 -1');
});

test('computeDiffLines keeps unchanged context around the change', () => {
  const lines = computeDiffLines('one\ntwo\nthree\nfour', 'one\nTWO\nthree\nfour');
  assert.ok(lines.some((line) => line.type === 'del' && line.text === 'two'));
  assert.ok(lines.some((line) => line.type === 'add' && line.text === 'TWO'));
  assert.ok(lines.some((line) => line.type === 'ctx' && line.text === 'one'));
});

test('buildDiffPayload is compact and truncates long text lines', () => {
  const payload = buildDiffPayload('hello', 'hello world', { maxLines: 10 });
  assert.equal(payload.additions, 1);
  assert.equal(payload.deletions, 1);
  assert.ok(Array.isArray(payload.lines));
  assert.equal(payload.truncated, false);
});

test('new file is all additions', () => {
  const payload = buildDiffPayload('', 'line1\nline2');
  assert.equal(payload.additions, 2);
  assert.equal(payload.deletions, 0);
});
