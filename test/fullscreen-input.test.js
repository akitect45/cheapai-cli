import assert from 'node:assert/strict';
import test from 'node:test';
import { displayWidth, iterateGraphemes, stripAnsi } from '../src/ui/draw.js';
import { createFullscreenChatUi } from '../src/ui/fullscreen.js';

function makeUi(input = '') {
  return createFullscreenChatUi({
    model: 'test-model',
    mode: 'ask',
    effort: 'off',
    cwd: process.cwd(),
    user: 'tester',
    sessionId: 'test-session',
    input,
  });
}

test('Korean jamo and syllables stay visible in the composer without overflowing', () => {
  for (const input of ['ㄱ', 'ㅏ', '가', '각', '한글', 'ㄱㄴㄷ']) {
    const frame = makeUi(input).renderSnapshot(80, 24);
    const plain = stripAnsi(frame);
    assert.ok(plain.includes(input), `expected composer to show ${JSON.stringify(input)}`);
    for (const line of frame.split('\n')) {
      assert.ok(displayWidth(line) < 80, `line overflow for ${JSON.stringify(input)}: ${displayWidth(line)}`);
    }
  }
});

test('composer height is stable for empty vs single jamo (no layout jump)', () => {
  const empty = makeUi('').renderSnapshot(80, 24).split('\n');
  const jamo = makeUi('ㄱ').renderSnapshot(80, 24).split('\n');
  assert.equal(empty.length, jamo.length);
  // Border rows for the input box should occupy the same vertical span.
  const emptyBox = empty.filter((line) => stripAnsi(line).includes('╭') || stripAnsi(line).includes('╰')).length;
  const jamoBox = jamo.filter((line) => stripAnsi(line).includes('╭') || stripAnsi(line).includes('╰')).length;
  assert.equal(emptyBox, jamoBox);
});

test('grapheme cursor units treat Hangul syllables as one unit each', () => {
  const text = '한글ㄱ';
  const graphemes = iterateGraphemes(text);
  assert.deepEqual(graphemes, ['한', '글', 'ㄱ']);
  assert.equal(displayWidth(text), 6);
});

test('repeated identical snapshots stay byte-identical (dirty paint safety)', () => {
  const ui = makeUi('테스트 입력');
  const a = ui.renderSnapshot(100, 30);
  const b = ui.renderSnapshot(100, 30);
  assert.equal(a, b);
});

test('busy header shows the current tool so long work is not a blank spinner', () => {
  const ui = makeUi();
  ui.setBusy(true);
  ui.agentHooks().onToolStart('bash', 'npm test');
  const plain = stripAnsi(ui.renderSnapshot(100, 30));
  assert.match(plain, /working/);
  assert.match(plain, /Bash/);
  assert.match(plain, /\d+s/);
});

test('update banner stays in the transcript instead of vanishing after a toast', () => {
  const ui = makeUi();
  ui.addBanner('업데이트 있음: 0.3.2 → 0.3.3 · /update 또는 cheapai --update', 'warning');
  const plain = stripAnsi(ui.renderSnapshot(100, 30));
  assert.match(plain, /업데이트 있음: 0\.3\.2 → 0\.3\.3/);
  assert.match(plain, /\/update/);
});

test('slash command arrows then Tab complete the highlighted command', () => {
  const ui = makeUi('/');
  const before = ui.renderSnapshot(80, 24);
  assert.ok(before.includes('/help'));
  assert.ok(before.includes('Tab complete'));
  ui.pressKey('\x1b[B');
  ui.pressKey('\t');
  assert.equal(ui.input, '/status');
  assert.equal(ui.focus, 'prompt');
});

test('Tab without a slash suggestion still toggles scrollback focus', () => {
  const ui = makeUi('hello');
  assert.equal(ui.focus, 'prompt');
  ui.pressKey('\t');
  assert.equal(ui.focus, 'scrollback');
  assert.equal(ui.input, 'hello');
  ui.pressKey('\t');
  assert.equal(ui.focus, 'prompt');
});
