import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createPermissionGate } from '../src/agent/permissions.js';
import { createToolRuntime } from '../src/agent/tools.js';
import { htmlTitle, htmlToText, fetchUrl } from '../src/agent/web-fetch.js';
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

test('bash timeout returns timed_out instead of hanging', async () => {
  const started = Date.now();
  const result = await runProcess({
    command: `"${process.execPath}" -e "setTimeout(()=>{}, 8000)"`,
    cwd: os.tmpdir(),
    timeoutMs: 120,
  });
  assert.equal(result.timed_out, true);
  assert.ok(Date.now() - started < 4000, `bash timeout hung for ${Date.now() - started}ms`);
});

test('glob returns immediately when already aborted', async () => withWorkspace(async (root) => {
  const runtime = createToolRuntime({ cwd: root });
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  await assert.rejects(
    () => runtime.execute('glob', { pattern: '**/*' }, { signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
  assert.ok(Date.now() - started < 500);
}));

test('web_fetch rejects non-http URLs and extracts HTML', async () => {
  const blocked = await fetchUrl('file:///etc/passwd');
  assert.equal(blocked.error.includes('http'), true);
  assert.equal(htmlTitle('<title>이전 작업</title>'), '이전 작업');
  assert.match(htmlTitle(`<html><head><title>${'이전작업'.repeat(40)}`), /이전/);
  assert.match(htmlToText('<p>Hello &amp; <b>world</b></p>'), /Hello & world/);
  const local = await fetchUrl('http://127.0.0.1/secret');
  assert.match(String(local.error), /private|local/i);

  const fetched = await fetchUrl('https://example.com/docs', {
    fetchImpl: async () => ({
      status: 200,
      url: 'https://example.com/docs',
      headers: { get: () => 'text/html; charset=utf-8' },
      arrayBuffer: async () => Buffer.from('<html><head><title>Docs</title></head><body><p>Read me</p></body></html>'),
    }),
  });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.title, 'Docs');
  assert.match(fetched.text, /Read me/);
});

test('git tool inspects and commits inside the workspace only', async () => {
  await withWorkspace(async (root) => {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(root, 'readme.txt'), 'hello\n');
    const runtime = createToolRuntime({ cwd: root });
    const before = await runtime.execute('git', { action: 'status' });
    assert.equal(before.repo, true);
    assert.equal(before.files.some((file) => file.path === 'readme.txt'), true);
    const committed = await runtime.execute('git', { action: 'commit', message: 'add readme', paths: ['readme.txt'] });
    assert.equal(committed.repo, true);
    assert.equal(committed.files.length, 0);
    const escaped = await runtime.execute('git', { action: 'diff', path: '../secret.txt' });
    assert.match(String(escaped.error || escaped.code), /workspace|Path|escapes/i);
  });
});

test('list_dir delete_file and move_file stay inside the workspace', async () => withWorkspace(async (root) => {
  const runtime = createToolRuntime({ cwd: root });
  fs.writeFileSync(path.join(root, 'keep.txt'), 'keep\n');
  fs.writeFileSync(path.join(root, 'gone.txt'), 'gone\n');
  const listed = await runtime.execute('list_dir', {});
  assert.equal(listed.entries.some((entry) => entry.name === 'keep.txt' && entry.type === 'file'), true);

  const moved = await runtime.execute('move_file', { from: 'keep.txt', to: 'nested/keep.txt' });
  assert.equal(moved.ok, true);
  assert.equal(fs.existsSync(path.join(root, 'keep.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'nested', 'keep.txt'), 'utf8'), 'keep\n');

  const deleted = await runtime.execute('delete_file', { path: 'gone.txt' });
  assert.equal(deleted.ok, true);
  assert.equal(fs.existsSync(path.join(root, 'gone.txt')), false);

  const blocked = await runtime.execute('delete_file', { path: '../outside.txt' });
  assert.equal(blocked.code, 'path_outside_workspace');
}));

test('edit_file applies multi-hunk edits and diagnoses misses', async () => withWorkspace(async (root) => {
  const runtime = createToolRuntime({ cwd: root });
  fs.writeFileSync(path.join(root, 'crlf.js'), 'function greet() {\r\n  return "hi";\r\n}\r\n');
  const crlf = await runtime.execute('edit_file', {
    path: 'crlf.js',
    old_string: 'function greet() {\n  return "hi";\n}',
    new_string: 'function greet() {\n  return "hello";\n}',
  });
  assert.equal(crlf.ok, true);
  assert.match(fs.readFileSync(path.join(root, 'crlf.js'), 'utf8'), /hello/);

  fs.writeFileSync(path.join(root, 'multi.js'), 'const a = 1;\nconst b = 2;\n');
  const multi = await runtime.execute('edit_file', {
    path: 'multi.js',
    edits: [
      { old_string: 'const a = 1;', new_string: 'const a = 10;' },
      { old_string: 'const b = 2;', new_string: 'const b = 20;' },
    ],
  });
  assert.equal(multi.ok, true);
  assert.equal(multi.replacements, 2);
  assert.equal(fs.readFileSync(path.join(root, 'multi.js'), 'utf8'), 'const a = 10;\nconst b = 20;\n');

  const missed = await runtime.execute('edit_file', {
    path: 'multi.js',
    old_string: 'const missing = true;',
    new_string: 'const missing = false;',
  });
  assert.match(String(missed.error), /not found/i);
  assert.equal(Array.isArray(missed.similar), true);
}));

test('read_file rejects binaries and grep supports literal context', async () => withWorkspace(async (root) => {
  const runtime = createToolRuntime({ cwd: root });
  fs.writeFileSync(path.join(root, 'note.txt'), 'alpha\nfoo(bar)\nbeta\n');
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 4]));
  const binary = await runtime.execute('read_file', { path: 'blob.bin' });
  assert.match(String(binary.error), /Binary/);

  const grep = await runtime.execute('grep', {
    pattern: 'foo(bar)',
    path: root,
    fixed_string: true,
    context: 1,
  });
  assert.equal(grep.matches.length, 1);
  assert.deepEqual(grep.matches[0].before, ['alpha']);
  assert.deepEqual(grep.matches[0].after, ['beta']);
}));

test('research tool records a METRIC keep on the workspace ledger', async () => withWorkspace(async (root) => {
  const runtime = createToolRuntime({ cwd: root });
  const init = await runtime.execute('research', {
    action: 'init',
    goal: 'echo metric',
    primaryMetric: 'latency_ms',
    command: `"${process.execPath}" -e "console.log('METRIC latency_ms=3')"`,
  });
  assert.equal(init.ok, true);
  const ran = await runtime.execute('research', { action: 'run' });
  assert.equal(ran.evidence.run.status, 'keep');
  assert.equal(ran.state.best, 3);
  assert.equal(fs.existsSync(path.join(root, '.cheapai', 'autoresearch', 'runs.jsonl')), true);
}));

test('permission gate allows git inspect and web_fetch without a prompt', () => {
  const ask = createPermissionGate('ask');
  assert.equal(ask.requiresApproval('web_fetch', { url: 'https://example.com' }), false);
  assert.equal(ask.requiresApproval('git', { action: 'status' }), false);
  assert.equal(ask.requiresApproval('git', { action: 'commit' }), true);
  assert.equal(ask.requiresApproval('ask_question'), false);
  assert.equal(ask.requiresApproval('task'), false);
  assert.equal(ask.requiresApproval('project_docs'), false);
  assert.equal(ask.requiresApproval('list_mcp_tools'), false);
  assert.equal(ask.requiresApproval('skill', { action: 'list' }), false);
  assert.equal(ask.requiresApproval('skill', { action: 'create' }), true);
  assert.equal(ask.requiresApproval('research', { action: 'status' }), false);
  assert.equal(ask.requiresApproval('research', { action: 'run' }), true);
  assert.equal(ask.requiresApproval('mcp_manage', { action: 'list' }), false);
  assert.equal(ask.requiresApproval('mcp_manage', { action: 'connect' }), true);
  assert.equal(ask.requiresApproval('call_mcp_tool'), true);
  assert.equal(ask.requiresApproval('bash'), true);
  assert.equal(ask.requiresApproval('list_dir'), false);
  assert.equal(ask.requiresApproval('delete_file'), true);
  const edits = createPermissionGate('accept-edits');
  assert.equal(edits.requiresApproval('move_file'), false);
  assert.equal(edits.requiresApproval('delete_file'), false);
  assert.equal(edits.requiresApproval('bash'), true);
});

function withWorkspace(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheapai-tool-test-'));
  return Promise.resolve(callback(root)).finally(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows can keep a dying child attached to the temp cwd briefly. */
    }
  });
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'git failed');
  }
}
