import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { createSession, saveSession } from '../src/agent/session.js';
import { createOperationJournal } from '../src/agent/operation-journal.js';
import { createFullscreenChatUi } from '../src/ui/fullscreen.js';

test('runtime emits monotonic events and rejects malformed tool JSON before permission', async () => withHome(async (root) => {
  let requests = 0;
  let permissionRequests = 0;
  const client = fakeClient(async () => {
    requests++;
    if (requests === 1) {
      return chunks([{
        choices: [{
          finish_reason: 'tool_calls',
          delta: {
            tool_calls: [{ index: 0, id: 'bad-call', function: { name: 'write_file', arguments: '{bad-json' } }],
          },
        }],
      }]);
    }
    return chunks([{ choices: [{ finish_reason: 'stop', delta: { content: 'finished' } }] }]);
  });
  const session = createSession({ cwd: root, model: 'test', systemPrompt: 'system' });
  const runtime = createAgentRuntime({
    client,
    model: 'test',
    session,
    permissionMode: 'ask',
    print: true,
    requestPermission() {
      permissionRequests++;
      return true;
    },
    ui: silentUi(),
  });
  const events = [];
  runtime.subscribe((event) => events.push(event));
  await runtime.run('write the file');

  const toolMessage = session.messages.find((message) => message.role === 'tool');
  assert.equal(JSON.parse(toolMessage.content).code, 'invalid_arguments');
  assert.equal(permissionRequests, 0);
  assert.equal(fs.existsSync(path.join(root, 'missing-content.txt')), false);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.equal(events.some((event) => event.type === 'tool_preflight'), true);
  assert.equal(events.some((event) => event.type === 'tool_start'), false);
  assert.equal(events.filter((event) => event.type === 'message_start').length, events.filter((event) => event.type === 'message_end').length);
  assert.equal(events.at(-1).type, 'agent_end');
}));

test('steering enters after a tool batch and follow-up waits for idle', async () => withHome(async (root) => {
  const requestMessages = [];
  let requests = 0;
  const client = fakeClient(async (body) => {
    requests++;
    requestMessages.push(structuredClone(body.messages));
    if (requests === 1) {
      return chunks([{
        choices: [{
          finish_reason: 'tool_calls',
          delta: {
            tool_calls: [{
              index: 0,
              id: 'bash-call',
              function: {
                name: 'bash',
                arguments: JSON.stringify({ command: `"${process.execPath}" -e "setTimeout(()=>{},80)"` }),
              },
            }],
          },
        }],
      }]);
    }
    return chunks([{ choices: [{ finish_reason: 'stop', delta: { content: requests === 2 ? 'first answer' : 'follow-up answer' } }] }]);
  });
  const session = createSession({ cwd: root, model: 'test', systemPrompt: 'system' });
  const runtime = createAgentRuntime({ client, model: 'test', session, permissionMode: 'yolo', print: true, ui: silentUi() });
  const events = [];
  runtime.subscribe((event) => events.push(event));
  const running = runtime.run('start');
  setTimeout(() => {
    runtime.enqueueSteering('steer now');
    runtime.enqueueFollowUp('after idle');
  }, 20);
  const result = await running;

  assert.equal(requests, 3);
  assert.equal(hasUserText(requestMessages[1], 'steer now'), true);
  assert.equal(hasUserText(requestMessages[1], 'after idle'), false);
  assert.equal(hasUserText(requestMessages[2], 'after idle'), true);
  assert.equal(result.text, 'follow-up answer');
  assert.equal(events.some((event) => event.type === 'tool_start'), true);
  assert.equal(events.some((event) => event.type === 'tool_end'), true);
}));

test('queued follow-ups can be promoted into mid-run steering', async () => withHome(async (root) => {
  const requestMessages = [];
  let requests = 0;
  const client = fakeClient(async (body) => {
    requests++;
    requestMessages.push(structuredClone(body.messages));
    if (requests === 1) {
      return chunks([{
        choices: [{
          finish_reason: 'tool_calls',
          delta: {
            tool_calls: [{
              index: 0,
              id: 'bash-call',
              function: {
                name: 'bash',
                arguments: JSON.stringify({ command: `"${process.execPath}" -e "setTimeout(()=>{},120)"` }),
              },
            }],
          },
        }],
      }]);
    }
    return chunks([{ choices: [{ finish_reason: 'stop', delta: { content: requests === 2 ? 'steered' : 'later' } }] }]);
  });
  const session = createSession({ cwd: root, model: 'test', systemPrompt: 'system' });
  const runtime = createAgentRuntime({ client, model: 'test', session, permissionMode: 'yolo', print: true, ui: silentUi() });
  const running = runtime.run('start');
  setTimeout(() => {
    assert.equal(runtime.enqueueFollowUp('queued later'), true);
    assert.deepEqual(runtime.queueSnapshot().followUps, ['queued later']);
    assert.equal(runtime.promoteFollowUpsToSteering(), 1);
    assert.deepEqual(runtime.queueSnapshot(), { followUps: [], steering: ['queued later'] });
  }, 20);
  const result = await running;

  assert.equal(requests, 2);
  assert.equal(hasUserText(requestMessages[1], 'queued later'), true);
  assert.equal(result.text, 'steered');
}));

test('multimodal user content is preserved in the session and provider request', async () => withHome(async (root) => {
  let requestMessages = null;
  const client = fakeClient(async (body) => {
    requestMessages = structuredClone(body.messages);
    return chunks([{ choices: [{ finish_reason: 'stop', delta: { content: 'image received' } }] }]);
  });
  const session = createSession({ cwd: root, model: 'test', systemPrompt: 'system' });
  const runtime = createAgentRuntime({ client, model: 'test', session, permissionMode: 'yolo', print: true, ui: silentUi() });
  const content = [
    { type: 'text', text: 'describe this image' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
  ];
  await runtime.run(content);

  assert.deepEqual(session.messages.find((message) => message.role === 'user').content, content);
  assert.deepEqual(requestMessages.find((message) => message.role === 'user').content, content);
  assert.equal(session.title, 'describe this image');
}));

test('sequential tool contracts are barriers while parallel tools retain source order', async () => withHome(async (root) => {
  let requests = 0;
  const batches = [];
  const starts = [];
  const ends = [];
  const client = fakeClient(async () => {
    requests++;
    if (requests === 1) {
      return chunks([{ choices: [{ finish_reason: 'tool_calls', delta: { tool_calls: [
        { index: 0, id: 'first', function: { name: 'bash', arguments: JSON.stringify({ command: `"${process.execPath}" -e "setTimeout(()=>require('fs').writeFileSync('order','1'),150)"`, timeout_ms: 1000 }) } },
        { index: 1, id: 'second', function: { name: 'bash', arguments: JSON.stringify({ command: `"${process.execPath}" -e "require('fs').appendFileSync('order','2')"`, timeout_ms: 1000 }) } },
      ] } }] }]);
    }
    return chunks([{ choices: [{ finish_reason: 'stop', delta: { content: 'done' } }] }]);
  });
  const session = createSession({ cwd: root, model: 'test', systemPrompt: 'system' });
  const runtime = createAgentRuntime({
    client,
    model: 'test',
    session,
    permissionMode: 'yolo',
    print: true,
    ui: {
      ...silentUi(),
      onToolBatch(items, meta) { batches.push({ items, meta }); },
      onToolStart(_name, _detail, meta) { starts.push(meta); },
      onToolEnd(_name, _detail, _status, _result, meta) { ends.push(meta); },
    },
  });
  await runtime.run('order the commands');
  assert.equal(fs.readFileSync(path.join(root, 'order'), 'utf8'), '12');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].meta.batchCount, 2);
  assert.deepEqual(batches[0].items.map((item) => item.callId), ['first', 'second']);
  assert.equal(new Set(batches[0].items.map((item) => item.batchId)).size, 1);
  assert.deepEqual(starts.map((meta) => meta.callId), ['first', 'second']);
  assert.deepEqual(ends.map((meta) => meta.callId), ['first', 'second']);
}));

test('uncertain operations are reconciled before a new provider request', async () => withHome(async (root) => {
  const session = createSession({ cwd: root, model: 'test', systemPrompt: 'system' });
  session.messages.push({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'bash', arguments: '{"command":"touch marker"}' } }],
  });
  saveSession(session);
  const journal = createOperationJournal({ sessionId: session.id });
  journal.begin({ operationId: `old-turn:old-call`, tool: 'bash', args: { command: 'touch marker' } });

  let requestBody;
  const client = fakeClient(async (body) => {
    requestBody = structuredClone(body.messages);
    return chunks([{ choices: [{ finish_reason: 'stop', delta: { content: 'continued' } }] }]);
  });
  const runtime = createAgentRuntime({ client, model: 'test', session, permissionMode: 'yolo', print: true, ui: silentUi() });
  await runtime.run('continue');
  const roles = requestBody.map((message) => message.role);
  assert.deepEqual(roles, ['system', 'assistant', 'tool', 'user']);
  assert.equal(requestBody[2].content.includes('operation_uncertain'), true);
}));

test('abort interrupts a pending permission decision', async () => withHome(async (root) => {
  let requests = 0;
  const client = fakeClient(async () => {
    requests++;
    return chunks([{ choices: [{ finish_reason: 'tool_calls', delta: { tool_calls: [{
      index: 0,
      id: 'approval-call',
      function: { name: 'write_file', arguments: JSON.stringify({ path: 'blocked.txt', content: 'no' }) },
    }] } }] }]);
  });
  const session = createSession({ cwd: root, model: 'test', systemPrompt: 'system' });
  const runtime = createAgentRuntime({
    client,
    model: 'test',
    session,
    permissionMode: 'ask',
    print: true,
    requestPermission: () => new Promise(() => {}),
    ui: silentUi(),
  });
  const events = [];
  runtime.subscribe((event) => events.push(event));
  const running = runtime.run('request approval');
  setTimeout(() => runtime.abort(), 20);
  await assert.rejects(running, (error) => error.name === 'AbortError');
  assert.equal(fs.existsSync(path.join(root, 'blocked.txt')), false);
  assert.equal(runtime.active, false);
  assert.equal(events.filter((event) => event.type === 'message_start').length, events.filter((event) => event.type === 'message_end').length);
  assert.equal(events.filter((event) => event.type === 'turn_start').length, events.filter((event) => event.type === 'turn_end').length);
  assert.equal(events.at(-1).type, 'agent_end');
}));

test('fullscreen permission overlay closes when its signal aborts', async () => {
  const ui = createFullscreenChatUi({ model: 'test', mode: 'ask', effort: 'off', cwd: process.cwd(), sessionId: 'permission-ui' });
  const controller = new AbortController();
  const pending = ui.requestPermission('write_file', 'blocked.txt', { signal: controller.signal });
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(ui.renderSnapshot(80, 24).includes('Permission · Write'), false);
});

function fakeClient(create) {
  return { chat: { completions: { create } } };
}

function chunks(values) {
  return { async *[Symbol.asyncIterator]() { yield* values; } };
}

function silentUi() {
  return {
    onThinking() {},
    onAssistantStart() {},
    onAssistantEnd() {},
    onDelta() {},
    onToolStart() {},
    onToolEnd() {},
  };
}

function hasUserText(messages, text) {
  return messages.some((message) => message.role === 'user' && message.content === text);
}

function withHome(callback) {
  const previous = process.env.CHEAPAI_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheapai-runtime-test-'));
  process.env.CHEAPAI_HOME = path.join(root, '.cheapai');
  return Promise.resolve(callback(root)).finally(() => {
    if (previous === undefined) delete process.env.CHEAPAI_HOME;
    else process.env.CHEAPAI_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}
