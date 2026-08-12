import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeConsoleBuffer,
  shellInvocation,
  utf8ChildEnvironment,
} from '../src/agent/process-runner.js';

test('Windows shell forces UTF-8 code page before the command', () => {
  const [shell, args] = shellInvocation('echo 안녕', 'win32', { ComSpec: 'cmd.exe' });
  assert.equal(shell, 'cmd.exe');
  assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(args[3], 'chcp 65001>nul 2>&1 & echo 안녕');
});

test('Windows shell keeps quoted executables intact after chcp prefix', () => {
  const [, args] = shellInvocation('"C:\\Program Files\\nodejs\\node.exe" --version', 'win32', { ComSpec: 'cmd.exe' });
  assert.equal(args[3], 'chcp 65001>nul 2>&1 & "C:\\Program Files\\nodejs\\node.exe" --version');
});

test('decodeConsoleBuffer accepts valid UTF-8 Korean', () => {
  const text = '한글 출력 테스트';
  assert.equal(decodeConsoleBuffer(Buffer.from(text, 'utf8'), 'win32'), text);
});

test('utf8ChildEnvironment sets encoding-friendly defaults', () => {
  const env = utf8ChildEnvironment({ FOO: '1', PYTHONIOENCODING: undefined });
  assert.equal(env.FOO, '1');
  assert.equal(env.PYTHONIOENCODING, 'utf-8');
  assert.equal(env.PYTHONUTF8, '1');
});
