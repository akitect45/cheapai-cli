import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { chatWithTools } from '../src/llm/client.js';
import { resolveWireApi } from '../src/config.js';
import {
  applyResponsesEvent,
  buildResponsesCreateBody,
  chatMessagesToResponsesInput,
  chatToolsToResponsesTools,
  createResponsesAccumulator,
  finalizeResponsesResult,
} from '../src/llm/responses-format.js';
import { resetResponsesWsSessions, toResponsesWsUrl } from '../src/llm/responses-ws.js';

test('resolveWireApi accepts Codex-style aliases', () => {
  const previous = process.env.CHEAPAI_WIRE_API;
  delete process.env.CHEAPAI_WIRE_API;
  try {
    assert.equal(resolveWireApi('responses-ws', { wireApi: 'chat' }), 'responses-ws');
    assert.equal(resolveWireApi('responses', {}), 'responses-ws');
    assert.equal(resolveWireApi('wss', {}), 'responses-ws');
    assert.equal(resolveWireApi(null, { wireApi: 'chat' }), 'chat');
  } finally {
    if (previous == null) delete process.env.CHEAPAI_WIRE_API;
    else process.env.CHEAPAI_WIRE_API = previous;
  }
});

test('chat messages convert to Responses input and function tools', () => {
  const { instructions, input } = chatMessagesToResponsesInput([
    { role: 'system', content: 'You are CheapAI.' },
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    { role: 'assistant', content: 'done' },
  ]);
  assert.equal(instructions, 'You are CheapAI.');
  assert.equal(input[0].role, 'user');
  assert.equal(input[0].content[1].type, 'input_image');
  assert.equal(input[1].type, 'function_call');
  assert.equal(input[1].call_id, 'call_1');
  assert.equal(input[2].type, 'function_call_output');
  assert.equal(input[3].content, 'done');
  assert.deepEqual(chatToolsToResponsesTools([{
    type: 'function',
    function: { name: 'bash', description: 'Run a command', parameters: { type: 'object' } },
  }]), [{
    type: 'function',
    name: 'bash',
    description: 'Run a command',
    parameters: { type: 'object' },
  }]);
  const body = buildResponsesCreateBody({
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
    reasoningEffort: 'low',
  });
  assert.equal(body.store, false);
  assert.equal(body.reasoning.effort, 'low');
  assert.equal(body.tools[0].name, 'bash');
});

test('Responses events accumulate text, thinking, and tool calls', () => {
  const state = createResponsesAccumulator();
  const deltas = [];
  const thinking = [];
  const feed = (event) => {
    const before = state.content.length;
    const beforeThink = state.thinking.length;
    applyResponsesEvent(state, event);
    if (state.content.length > before) deltas.push(state.content.slice(before));
    if (state.thinking.length > beforeThink) thinking.push(state.thinking.slice(beforeThink));
  };
  feed({ type: 'response.created', response: { id: 'resp_1' } });
  feed({ type: 'response.reasoning_summary_text.delta', delta: 'plan' });
  feed({ type: 'response.output_text.delta', delta: 'hello ' });
  feed({ type: 'response.output_text.delta', text: 'world' });
  feed({
    type: 'response.output_item.added',
    item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'bash', arguments: '' },
  });
  feed({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"command":' });
  feed({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"pwd"}' });
  feed({
    type: 'response.completed',
    response: {
      usage: { input_tokens: 4, output_tokens: 6, cost_credits: 1.5 },
      output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'bash', arguments: '{"command":"pwd"}' }],
    },
  });
  const result = finalizeResponsesResult(state);
  assert.deepEqual(deltas, ['hello ', 'world']);
  assert.deepEqual(thinking, ['plan']);
  assert.equal(result.content, 'hello world');
  assert.equal(result.tool_calls.length, 1);
  assert.equal(result.tool_calls[0].id, 'call_9');
  assert.equal(result.tool_calls[0].function.arguments, '{"command":"pwd"}');
  assert.equal(result.usage.prompt_tokens, 4);
  assert.equal(result.usage.cost_credits, 1.5);
  assert.equal(result.finish_reason, 'tool_calls');
});

test('toResponsesWsUrl maps CheapAI /v1 bases to /v1/responses', () => {
  assert.equal(toResponsesWsUrl('https://api.cheapai.im/v1'), 'wss://api.cheapai.im/v1/responses');
  assert.equal(toResponsesWsUrl('http://127.0.0.1:3600/v1'), 'ws://127.0.0.1:3600/v1/responses');
  assert.equal(toResponsesWsUrl('https://api.cheapai.im/v1/responses'), 'wss://api.cheapai.im/v1/responses');
});

test('responses-ws provider streams Codex frames over a local socket', async () => {
  const previousHome = process.env.CHEAPAI_HOME;
  const apiKey = 'csk_test_responses_ws_0001';
  const { server, port } = await listenMock((ws) => {
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type !== 'response.create') return;
      assert.equal(frame.model, 'gpt-5.6-sol');
      assert.equal(frame.store, false);
      assert.ok(Array.isArray(frame.input));
      ws.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_ws' } }));
      ws.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' }));
      ws.send(JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_ws',
          usage: { input_tokens: 2, output_tokens: 1 },
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        },
      }));
    });
  });
  process.env.CHEAPAI_HOME = `/tmp/cheapai-ws-test-${process.pid}`;
  try {
    const deltas = [];
    const result = await chatWithTools({
      client: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey },
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'ping' }],
      wireApi: 'responses-ws',
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey,
      onDelta: (value) => deltas.push(value),
    });
    assert.deepEqual(deltas, ['ok']);
    assert.equal(result.content, 'ok');
    assert.equal(result.usage.output_tokens, 1);
  } finally {
    resetResponsesWsSessions();
    await closeServer(server);
    if (previousHome == null) delete process.env.CHEAPAI_HOME;
    else process.env.CHEAPAI_HOME = previousHome;
  }
});

function listenMock(onConnection) {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!String(req.headers.authorization || '').startsWith('Bearer csk_')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}
