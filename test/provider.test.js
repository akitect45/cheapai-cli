import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { chatWithTools } from '../src/llm/client.js';
import { classifyProviderError } from '../src/llm/errors.js';
import { normalizeModelMetadata } from '../src/llm/providers.js';

test('provider retries transient failures within budget', async () => {
  let attempts = 0;
  const client = fakeClient(async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('temporary server failure'), { status: 503 });
    return chunks([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
  });
  const deltas = [];
  const result = await chatWithTools({ client, model: 'test', messages: [], maxRetries: 1, onDelta: (value) => deltas.push(value) });
  assert.equal(attempts, 2);
  assert.equal(result.content, 'ok');
  assert.deepEqual(deltas, ['ok']);
});

test('provider never retries after visible output', async () => {
  let attempts = 0;
  const client = fakeClient(async () => {
    attempts++;
    return {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: 'partial' } }] };
        throw Object.assign(new Error('socket reset'), { status: 503 });
      },
    };
  });
  await assert.rejects(() => chatWithTools({ client, model: 'test', messages: [], maxRetries: 3, onDelta() {} }));
  assert.equal(attempts, 1);
});

test('provider never retries after tool-call fragments have started', async () => {
  let attempts = 0;
  const client = fakeClient(async () => {
    attempts++;
    return {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'bash', arguments: '{' } }] } }] };
        throw Object.assign(new Error('socket reset'), { status: 503 });
      },
    };
  });
  await assert.rejects(() => chatWithTools({ client, model: 'test', messages: [], maxRetries: 3 }));
  assert.equal(attempts, 1);
});

test('provider errors have stable classifications', () => {
  assert.deepEqual(classifyProviderError({ status: 401 }), { category: 'auth', retryable: false, status: 401 });
  assert.equal(classifyProviderError({ status: 429 }).retryable, true);
  assert.equal(classifyProviderError(new Error('ECONNRESET')).category, 'network');
});

test('provider model metadata is normalized without discarding source fields', () => {
  const model = normalizeModelMetadata({ id: 'test', context_window: 200_000, pricing: { input: 1 }, custom: true });
  assert.equal(model.provider, 'openai-compatible');
  assert.equal(model.contextWindow, 200_000);
  assert.deepEqual(model.cost, { input: 1 });
  assert.equal(model.custom, true);
});

test('provider retry delay removes its abort listener after success', async () => {
  let attempts = 0;
  const controller = new AbortController();
  const client = fakeClient(async () => {
    attempts++;
    if (attempts === 1) {
      throw Object.assign(new Error('rate limited'), { status: 429, headers: { 'retry-after': '0.001' } });
    }
    return chunks([{ choices: [{ finish_reason: 'stop', delta: { content: 'ok' } }] }]);
  });
  await chatWithTools({ client, model: 'test', messages: [], signal: controller.signal, maxRetries: 1 });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

function fakeClient(create) {
  return { chat: { completions: { create } } };
}

function chunks(values) {
  return { async *[Symbol.asyncIterator]() { yield* values; } };
}
