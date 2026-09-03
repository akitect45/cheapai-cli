import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loginWithApiKey } from '../src/auth.js';
import { loadAuth } from '../src/config.js';

test('loginWithApiKey persists only after a successful 2xx check', async () => withHome(async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ status: 500, ok: false });
    await assert.rejects(() => loginWithApiKey('csk_test_login_0001'), /실패/);
    assert.equal(loadAuth(), null);

    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    await assert.rejects(() => loginWithApiKey('csk_test_login_0001'), /네트워크/);
    assert.equal(loadAuth(), null);

    globalThis.fetch = async () => ({ status: 401, ok: false });
    await assert.rejects(() => loginWithApiKey('csk_test_login_0001'), /유효하지 않습니다/);
    assert.equal(loadAuth(), null);

    globalThis.fetch = async () => ({ status: 200, ok: true });
    const auth = await loginWithApiKey('csk_test_login_0001', { keyName: 'test' });
    assert.equal(auth.validated, true);
    assert.equal(loadAuth()?.apiKey, 'csk_test_login_0001');
  } finally {
    globalThis.fetch = originalFetch;
  }
}));

function withHome(callback) {
  const previous = process.env.CHEAPAI_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheapai-auth-test-'));
  process.env.CHEAPAI_HOME = path.join(root, '.cheapai');
  return Promise.resolve(callback(root)).finally(() => {
    if (previous === undefined) delete process.env.CHEAPAI_HOME;
    else process.env.CHEAPAI_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}
