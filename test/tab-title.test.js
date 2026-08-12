import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTabTitle } from '../src/ui/draw.js';

test('idle tab title includes session label', () => {
  assert.equal(formatTabTitle({ busy: false, sessionLabel: 'Fix auth bug' }), 'cheapai · Fix auth bug');
});

test('busy tab title blinks filled and empty dots', () => {
  assert.equal(
    formatTabTitle({ busy: true, thinking: false, sessionLabel: 'demo', frame: 0 }),
    '● working... demo',
  );
  assert.equal(
    formatTabTitle({ busy: true, thinking: false, sessionLabel: 'demo', frame: 4 }),
    '○ working... demo',
  );
  assert.equal(
    formatTabTitle({ busy: true, thinking: true, sessionLabel: 'demo', frame: 0 }),
    '● thinking... demo',
  );
  assert.equal(
    formatTabTitle({ busy: true, thinking: true, sessionLabel: 'demo', frame: 4 }),
    '○ thinking... demo',
  );
});

test('tab title falls back and truncates long session names', () => {
  assert.equal(formatTabTitle({ busy: false, sessionLabel: '' }), 'cheapai · session');
  const long = 'x'.repeat(80);
  assert.equal(formatTabTitle({ busy: false, sessionLabel: long }), `cheapai · ${'x'.repeat(48)}`);
});
