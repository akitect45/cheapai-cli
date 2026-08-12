import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMarkdown, stripAnsi } from '../src/ui/draw.js';

test('formatMarkdown renders **bold** by removing markers', () => {
  const styled = formatMarkdown('hello **world** now');
  assert.equal(stripAnsi(styled), 'hello world now');
  assert.match(styled, /world/);
  assert.ok(!styled.includes('**'));
});

test('formatMarkdown leaves unfinished ** spans alone', () => {
  assert.equal(stripAnsi(formatMarkdown('hello **world')), 'hello **world');
});

test('formatMarkdown does not style inside inline code or fences', () => {
  assert.equal(stripAnsi(formatMarkdown('use `**not bold**` please')), 'use `**not bold**` please');
  const fenced = formatMarkdown('before\n```\n**still raw**\n```\nafter **bold**');
  const plain = stripAnsi(fenced);
  assert.match(plain, /\*\*still raw\*\*/);
  assert.match(plain, /after bold$/);
  assert.ok(!plain.endsWith('after **bold**'));
});

test('formatMarkdown keeps multi-pair bold on one line', () => {
  assert.equal(stripAnsi(formatMarkdown('**a** and **b**')), 'a and b');
});
