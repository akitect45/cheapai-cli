import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createToolRuntime } from '../src/agent/tools.js';
import { runProcess, safeChildEnvironment } from '../src/agent/process-runner.js';

test('tool schemas reject malformed arguments before execution', async () => withWorkspace(async (root) => {
  const runtime = createToolRuntime({ cwd: root });
  const result = await runtime.execute('write_file', { path: 'missing-content.txt' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_arguments');
  assert.equal(fs.existsSync(path.join(root, 'missing-content.txt')), false);
}));

test('workspace policy blocks traversal and symlink escapes', { skip: process.platform === 'win32' }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cheapai-path-test-'));
  const root = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  try {
    const runtime = createToolRuntime({ cwd: root, pathMode: 'workspace' });
    const traversal = await runtime.execute('read_file', { path: '../outside/secret.txt' });
    const symlink = await runtime.execute('read_file', { path: 'escape/secret.txt' });
    const recursive = await runtime.execute('grep', { pattern: 'secret', path: root });
    assert.equal(traversal.code, 'path_outside_workspace');
    assert.equal(symlink.code, 'path_outside_workspace');
    assert.equal(recursive.matches.length, 0);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('bash children do not inherit provider credentials', () => {
  const env = safeChildEnvironment({ CHEAPAI_API_KEY: 'secret', CHEAPSUB_API_KEY: 'secret', PATH: '/bin' });
  assert.equal(env.CHEAPAI_API_KEY, undefined);
  assert.equal(env.CHEAPSUB_API_KEY, undefined);
  assert.equal(env.PATH, '/bin');
});

test('aborting bash terminates its Unix process group', { skip: process.platform === 'win32' }, async () => withWorkspace(async (root) => {
  const controller = new AbortController();
  const command = `${JSON.stringify(process.execPath)} -e "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"`;
  const running = runProcess({ command, cwd: root, signal: controller.signal, timeoutMs: 10_000 });
  setTimeout(() => controller.abort(), 150);
  const result = await running;
  assert.equal(result.aborted, true);
  const childPid = Number(result.stdout.trim().split(/\s+/).at(-1));
  if (Number.isInteger(childPid) && childPid > 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(() => process.kill(childPid, 0), (error) => error.code === 'ESRCH');
  }
}));

function withWorkspace(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheapai-tool-test-'));
  return Promise.resolve(callback(root)).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}
