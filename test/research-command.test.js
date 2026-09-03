import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHarnessCommand } from '../src/research/command.js';
import { isResearchMutating } from '../src/research/index.js';

test('preferred command wins over discovered scripts', () => {
  const resolved = resolveHarnessCommand({
    cwd: '/tmp/workspace',
    preferredCommand: 'node bench.js',
    platform: 'win32',
    existsSync: () => true,
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.command, 'node bench.js');
  assert.equal(resolved.source, 'preferred');
});

test('Windows prefers cmd then ps1 then bash', () => {
  const present = new Set(['autoresearch.ps1', 'autoresearch.sh']);
  const resolved = resolveHarnessCommand({
    cwd: 'C:\\proj',
    platform: 'win32',
    existsSync: (filePath) => present.has(filePath.replace(/\\/g, '/').split('/').pop()),
  });
  assert.equal(resolved.source, 'autoresearch.ps1');
  assert.match(resolved.command, /powershell/);

  const cmdFirst = resolveHarnessCommand({
    cwd: 'C:\\proj',
    platform: 'win32',
    existsSync: (filePath) => filePath.endsWith('autoresearch.cmd'),
  });
  assert.equal(cmdFirst.command, 'autoresearch.cmd');
});

test('POSIX prefers the shell script', () => {
  const resolved = resolveHarnessCommand({
    cwd: '/tmp/ws',
    platform: 'linux',
    existsSync: (filePath) => filePath.endsWith('autoresearch.sh') || filePath.endsWith('autoresearch.cmd'),
  });
  assert.equal(resolved.command, 'bash autoresearch.sh');
});

test('missing harness command fails closed', () => {
  const resolved = resolveHarnessCommand({
    cwd: '/tmp/empty',
    platform: 'linux',
    existsSync: () => false,
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.error, 'harness_command_missing');
});

test('status is the only non-mutating research action', () => {
  assert.equal(isResearchMutating('status'), false);
  assert.equal(isResearchMutating('init'), true);
  assert.equal(isResearchMutating('run'), true);
  assert.equal(isResearchMutating('clear'), true);
});
