import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEdits, applyExactReplace, diagnoseEditMiss, normalizeEditList } from '../src/agent/edit-match.js';
import { serializeToolResult } from '../src/agent/tool-result.js';
import { MAX_JSONRPC_BYTES, readRpc } from '../src/agent/mcp.js';
import { isBlockedHost } from '../src/agent/web-fetch.js';
import { safePackageVersion } from '../src/update.js';

test('edit match tolerates CRLF and reports nearby lines', () => {
  const file = 'function greet() {\r\n  return "hi";\r\n}\r\n';
  const replaced = applyExactReplace(file, 'function greet() {\n  return "hi";\n}', 'function greet() {\n  return "yo";\n}');
  assert.equal(replaced.ok, true);
  assert.equal(replaced.normalized, true);
  assert.match(replaced.text, /yo/);

  const miss = diagnoseEditMiss('const alpha = 1;\nconst beta = 2;\n', 'const alhpa = 1;');
  assert.match(miss.error, /not found/);
  assert.equal(miss.similar.some((item) => item.line === 1), true);
});

test('multi-edit applies in order and stops on the first miss', () => {
  const applied = applyEdits('one\ntwo\n', [
    { old_string: 'one', new_string: '1' },
    { old_string: 'two', new_string: '2' },
  ]);
  assert.equal(applied.ok, true);
  assert.equal(applied.text, '1\n2\n');
  assert.equal(applied.replacements, 2);

  const failed = applyEdits('one\n', [
    { old_string: 'missing', new_string: 'x' },
  ]);
  assert.equal(failed.ok, false);
  assert.equal(failed.failed_index, 0);
  assert.deepEqual(normalizeEditList({ path: 'a', old_string: 'x', new_string: 'y' })[0].old_string, 'x');
});

test('tool results stay valid JSON when truncated', () => {
  const huge = { content: 'x'.repeat(120_000), files: Array.from({ length: 400 }, (_, i) => `f${i}`) };
  const raw = serializeToolResult(huge);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.truncated, true);
  assert.equal(raw.length <= 80_000, true);
  assert.ok(parsed.original_chars > 80_000);
});

test('MCP Content-Length above the cap is rejected before buffering the body', () => {
  const header = `Content-Length: ${MAX_JSONRPC_BYTES + 1}\r\n\r\n`;
  assert.throws(() => readRpc(Buffer.from(header)), /too large/);
  const ok = readRpc(Buffer.from('Content-Length: 2\r\n\r\n{}'));
  assert.deepEqual(ok.message, {});
});

test('web_fetch blocks private hosts and updater rejects unsafe versions', () => {
  assert.equal(isBlockedHost('127.0.0.1'), true);
  assert.equal(isBlockedHost('10.0.0.8'), true);
  assert.equal(isBlockedHost('169.254.169.254'), true);
  assert.equal(isBlockedHost('example.com'), false);
  assert.equal(safePackageVersion('0.3.6'), '0.3.6');
  assert.throws(() => safePackageVersion('1.0.0 & calc.exe'), /버전/);
});
