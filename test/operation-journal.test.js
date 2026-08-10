import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createOperationJournal } from '../src/agent/operation-journal.js';
import { processStartIdentity } from '../src/agent/session-lock.js';

test('completed operations replay their durable result without re-execution', () => withHome(() => {
  const journal = createOperationJournal({ sessionId: 'journal-complete' });
  const first = journal.begin({ operationId: 'turn:call', tool: 'write_file', args: { path: 'a' } });
  assert.equal(first.execute, true);
  journal.complete('turn:call', { ok: true, path: 'a' });

  const duplicate = journal.begin({ operationId: 'turn:call', tool: 'write_file', args: { path: 'a' } });
  assert.equal(duplicate.execute, false);
  assert.deepEqual(duplicate.result, { ok: true, path: 'a' });
  assert.throws(
    () => journal.begin({ operationId: 'turn:call', tool: 'write_file', args: { path: 'b' } }),
    { code: 'operation_id_conflict' },
  );
}));

test('nonterminal operations recover as uncertain and are never replayed', () => withHome(() => {
  const first = createOperationJournal({ sessionId: 'journal-uncertain' });
  first.begin({ operationId: 'turn:call', tool: 'bash', args: { command: 'touch marker' } });

  const restarted = createOperationJournal({ sessionId: 'journal-uncertain' });
  const recovered = restarted.recover();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].state, 'uncertain');
  const duplicate = restarted.begin({ operationId: 'turn:call', tool: 'bash', args: { command: 'touch marker' } });
  assert.equal(duplicate.execute, false);
  assert.equal(duplicate.record.state, 'uncertain');
}));

test('a malformed final journal record is repaired', () => withHome(() => {
  const journal = createOperationJournal({ sessionId: 'journal-truncated' });
  journal.begin({ operationId: 'turn:call', tool: 'write_file', args: { path: 'a' } });
  fs.appendFileSync(journal.filePath, '{"state":');
  assert.doesNotThrow(() => journal.records());
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(journal.filePath, 'utf8').trim().split('\n').at(-1)));
}));

test('recovery force-kills an orphan process that ignores SIGTERM', { skip: process.platform === 'win32' }, async () => withHome(async () => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  await new Promise((resolve) => child.once('spawn', resolve));
  const journal = createOperationJournal({ sessionId: 'journal-orphan' });
  journal.begin({ operationId: 'turn:call', tool: 'bash', args: { command: 'stubborn' } });
  journal.processStarted('turn:call', {
    pid: child.pid,
    processStartId: processStartIdentity(child.pid),
    command: 'stubborn',
  });
  try {
    createOperationJournal({ sessionId: 'journal-orphan' }).recover();
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.throws(() => process.kill(child.pid, 0), (error) => error.code === 'ESRCH');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}));

function withHome(callback) {
  const previous = process.env.CHEAPAI_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheapai-journal-test-'));
  process.env.CHEAPAI_HOME = path.join(root, '.cheapai');
  return Promise.resolve().then(() => callback(root)).finally(() => {
    if (previous === undefined) delete process.env.CHEAPAI_HOME;
    else process.env.CHEAPAI_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}
