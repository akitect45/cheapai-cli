import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { VERSION } from '../src/ui/theme.js';
import {
  checkForUpdate,
  formatUpdateNotice,
  installLatestVersion,
  isNewerVersion,
  npmInstallArgs,
} from '../src/update.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

test('CLI VERSION always matches package.json (prevents stuck update banners)', () => {
  assert.equal(VERSION, pkg.version);
  assert.equal(isNewerVersion(pkg.version, VERSION), false);
});

test('isNewerVersion treats the published 0.3.2 vs 0.3.3 mismatch as an update', () => {
  assert.equal(isNewerVersion('0.3.3', '0.3.2'), true);
  assert.equal(isNewerVersion('0.3.3', '0.3.3'), false);
  assert.equal(isNewerVersion('0.3.2', '0.3.3'), false);
});

test('update notice tells the user how to install, not a local npm i', () => {
  const notice = formatUpdateNotice({
    currentVersion: '0.3.2',
    latestVersion: '0.3.3',
    installCommand: 'cheapai --update',
  });
  assert.match(notice, /업데이트 있음: 0\.3\.2 → 0\.3\.3/);
  assert.match(notice, /\/update/);
  assert.match(notice, /cheapai --update/);
  assert.equal(notice.includes('npm i @akitect/cheapai'), false);
});

test('checkForUpdate returns null when already on latest', async () => withHome(async () => {
  const info = await checkForUpdate({
    fetchImpl: async () => jsonResponse({ 'dist-tags': { latest: VERSION } }),
    timeoutMs: 200,
  });
  assert.equal(info, null);
}));

test('checkForUpdate times out instead of hanging on a stuck registry body', async () => withHome(async () => {
  const started = Date.now();
  const info = await checkForUpdate({
    fetchImpl: async () => ({
      ok: true,
      json: () => new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('hung registry')), 30_000);
        timer.unref?.();
      }),
    }),
    timeoutMs: 80,
  });
  assert.equal(info, null);
  assert.ok(Date.now() - started < 1500, `update check hung for ${Date.now() - started}ms`);
}));

test('installLatestVersion runs a global npm install only when newer', async () => withHome(async () => {
  const installs = [];
  const skipped = await installLatestVersion({
    fetchImpl: async () => jsonResponse({ 'dist-tags': { latest: VERSION } }),
    runInstall: async (args) => { installs.push(args); },
    timeoutMs: 200,
  });
  assert.equal(skipped.updated, false);
  assert.equal(installs.length, 0);

  const newer = '9.9.9';
  const result = await installLatestVersion({
    fetchImpl: async () => jsonResponse({ 'dist-tags': { latest: newer } }),
    runInstall: async (args) => { installs.push(args); },
    timeoutMs: 200,
  });
  assert.equal(result.updated, true);
  assert.deepEqual(installs[0], npmInstallArgs(newer));
  assert.equal(installs[0].includes('--global'), true);
}));

function jsonResponse(body) {
  return {
    ok: true,
    json: async () => body,
  };
}

function withHome(callback) {
  const previous = process.env.CHEAPAI_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheapai-update-test-'));
  process.env.CHEAPAI_HOME = path.join(root, '.cheapai');
  return Promise.resolve(callback(root)).finally(() => {
    if (previous === undefined) delete process.env.CHEAPAI_HOME;
    else process.env.CHEAPAI_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}
