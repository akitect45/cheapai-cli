import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { ensureHome } from '../src/config.js';
import {
  acquireSession,
  appendSessionEntry,
  bindSessionLease,
  createSession,
  loadSession,
  releaseSessionLease,
  transferSessionLease,
  saveSession,
  sessionPath,
  sessionsDir,
} from '../src/agent/session.js';

test('legacy JSON sessions migrate once to recoverable v2 JSONL', () => withHome((home) => {
  ensureHome();
  const legacy = {
    id: 'legacy-session',
    cwd: home,
    model: 'test-model',
    title: 'Legacy',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
    usage: { totalTokens: 12 },
    compactions: [{ at: '2026-01-02T00:00:00.000Z' }],
    undoStack: [{ id: 'turn-1' }],
  };
  const oldPath = path.join(sessionsDir(), `${legacy.id}.json`);
  fs.writeFileSync(oldPath, JSON.stringify(legacy), 'utf8');

  const loaded = loadSession(legacy.id);
  assert.equal(loaded.title, legacy.title);
  assert.deepEqual(loaded.messages, legacy.messages);
  assert.deepEqual(loaded.undoStack, legacy.undoStack);
  assert.equal(loaded.storageVersion, 2);
  assert.equal(fs.existsSync(sessionPath(legacy.id)), true);
  assert.equal(fs.existsSync(`${oldPath}.v1.bak`), true);
  assert.equal(fs.existsSync(oldPath), false);
}));

test('a malformed final JSONL line is discarded without losing the last snapshot', () => withHome((home) => {
  const session = createSession({ cwd: home, model: 'test-model', systemPrompt: 'system' });
  session.title = 'Before truncation';
  saveSession(session);
  fs.appendFileSync(sessionPath(session.id), '{"type":"session_state"');

  const loaded = loadSession(session.id);
  assert.equal(loaded.title, 'Before truncation');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(sessionPath(session.id), 'utf8').trim().split('\n').at(-1)));
}));

test('session ids cannot traverse outside the session directory', () => withHome(() => {
  assert.equal(loadSession('../config'), null);
  assert.throws(() => sessionPath('../config'), { code: 'invalid_session_id' });
}));

test('session leases reject concurrent owners and reclaim mismatched process identities', () => withHome((home) => {
  const session = createSession({ cwd: home, model: 'test-model', systemPrompt: 'system' });
  saveSession(session);
  const lease = acquireSession(session.id);
  assert.throws(() => acquireSession(session.id), { code: 'session_already_active' });
  const { lockPath } = lease;
  lease.release();

  fs.writeFileSync(lockPath, JSON.stringify({
    token: 'stale-token',
    pid: process.pid,
    processStartId: 'different-process-start',
    sessionId: session.id,
  }), { mode: 0o600 });
  const reclaimed = acquireSession(session.id);
  assert.notEqual(reclaimed.token, 'stale-token');
  reclaimed.release();
}));

test('corrupt lock and stale reclaim guard files do not permanently block a session', () => withHome((home) => {
  const session = createSession({ cwd: home, model: 'test-model', systemPrompt: 'system' });
  saveSession(session);
  const first = acquireSession(session.id);
  const { lockPath } = first;
  first.release();

  fs.writeFileSync(lockPath, '');
  const repaired = acquireSession(session.id);
  repaired.release();

  fs.writeFileSync(lockPath, JSON.stringify({
    token: 'stale',
    pid: process.pid,
    processStartId: 'different-process-start',
    sessionId: session.id,
  }));
  const guardPath = `${lockPath}.reclaim`;
  fs.writeFileSync(guardPath, '');
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(guardPath, old, old);
  const afterGuard = acquireSession(session.id);
  afterGuard.release();
}));

test('session logs are owner-readable only on POSIX', { skip: process.platform === 'win32' }, () => withHome((home) => {
  const session = createSession({ cwd: home, model: 'test-model', systemPrompt: 'system' });
  saveSession(session);
  assert.equal(fs.statSync(sessionPath(session.id)).mode & 0o777, 0o600);
}));

test('a lease transfers when the active session is reloaded with the same id', () => withHome((home) => {
  const session = createSession({ cwd: home, model: 'test-model', systemPrompt: 'system' });
  saveSession(session);
  const lease = acquireSession(session.id);
  bindSessionLease(session, lease);
  const reloaded = loadSession(session.id);
  transferSessionLease(session, reloaded);
  reloaded.title = 'same active session';
  assert.doesNotThrow(() => saveSession(reloaded));
  releaseSessionLease(reloaded);
}));

test('an active lease fences writers in another process', () => withHome((home) => {
  const session = createSession({ cwd: home, model: 'test-model', systemPrompt: 'system' });
  saveSession(session);
  const lease = acquireSession(session.id);
  bindSessionLease(session, lease);
  try {
    const sourcePath = path.resolve('src/agent/session.js');
    const script = `import { loadSession, saveSession } from ${JSON.stringify(pathToFileURL(sourcePath).href)}; const s=loadSession(${JSON.stringify(session.id)}); s.title='blocked'; saveSession(s);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: path.resolve('.'),
      env: { ...process.env, CHEAPAI_HOME: process.env.CHEAPAI_HOME },
      encoding: 'utf8',
    });
    assert.notEqual(child.status, 0);
    assert.match(`${child.stderr}${child.stdout}`, /already active|session_already_active/i);
  } finally {
    releaseSessionLease(session);
  }
}));

test('custom session entries survive snapshot log compaction', () => withHome((home) => {
  const session = createSession({ cwd: home, model: 'test-model', systemPrompt: 'system' });
  saveSession(session);
  appendSessionEntry(session, 'custom', { namespace: 'extension', value: 'keep-me' });
  for (let index = 0; index < 64; index++) {
    session.title = `title-${index}`;
    saveSession(session);
  }
  const text = fs.readFileSync(sessionPath(session.id), 'utf8');
  assert.equal(text.includes('keep-me'), true);
}));

test('short-id resume migrates a newer coexisting legacy snapshot', () => withHome((home) => {
  const session = createSession({ cwd: home, model: 'test-model', systemPrompt: 'system' });
  session.id = 'prefix-migration-session';
  session.title = 'v2 title';
  saveSession(session);
  const legacyPath = path.join(sessionsDir(), `${session.id}.json`);
  const legacy = { ...session, storageVersion: undefined, title: 'newer legacy title' };
  fs.writeFileSync(legacyPath, JSON.stringify(legacy), 'utf8');
  const newer = new Date(Date.now() + 2000);
  fs.utimesSync(legacyPath, newer, newer);

  const loaded = loadSession('prefix-migration');
  assert.equal(loaded.title, 'newer legacy title');
  assert.equal(loadSession(session.id).title, 'newer legacy title');
  assert.equal(fs.existsSync(`${legacyPath}.v1.bak`), true);
}));

function withHome(callback) {
  const previous = process.env.CHEAPAI_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheapai-session-test-'));
  process.env.CHEAPAI_HOME = path.join(root, '.cheapai');
  try {
    return callback(root);
  } finally {
    if (previous === undefined) delete process.env.CHEAPAI_HOME;
    else process.env.CHEAPAI_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
