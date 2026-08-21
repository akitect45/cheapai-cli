import crypto from 'node:crypto';
import { chatWithTools } from '../llm/client.js';
import { createPermissionGate } from './permissions.js';
import { createToolRuntime } from './tools.js';
import { parseToolArguments } from './tool-contract.js';
import { isRetryableProviderError } from '../llm/errors.js';

const PARENT_ONLY = new Set(['task', 'ask_question']);

export function subagentTitle(args = {}) {
  const title = String(args.title || '').trim();
  if (title) return title.slice(0, 80);
  const description = String(args.description || '').trim();
  if (description) return description.slice(0, 80);
  const prompt = String(args.prompt || '');
  const first = prompt.split('\n').find((line) => line.trim()) || 'Subagent';
  return first.trim().slice(0, 48);
}

export async function runSubagent({
  args = {},
  client,
  model,
  cwd,
  pathMode,
  extraRoots,
  permissionMode = 'ask',
  requestPermission = null,
  print = false,
  ui = null,
  signal = null,
  temperature = 0.2,
  reasoningEffort = null,
  maxTurns = 40,
  customTools = [],
  mcp = null,
  onFileChange = null,
  onTodo = null,
} = {}) {
  const id = crypto.randomUUID();
  const prompt = String(args.prompt || '').trim();
  const title = subagentTitle(args);
  const emit = (status, extra = {}) => {
    ui?.onSubagent?.({ id, title, status, ...extra });
  };
  if (!prompt) {
    emit('error', { detail: 'prompt is required' });
    return { error: 'prompt is required', title };
  }
  emit('running', { detail: 'starting', prompt: prompt.slice(0, 200) });
  const runtime = createToolRuntime({
    cwd,
    pathMode,
    extraRoots,
    customTools,
    mcp,
    includeParentTools: false,
    onTodo,
    onFileChange,
  });
  let gate = createPermissionGate(permissionMode, requestPermission, {
    interactive: !print,
    toolResolver: (name) => runtime.registry.get(name),
  });
  const messages = [
    {
      role: 'system',
      content: `${runtime.systemExtra || ''}You are a focused worker spawned by the parent agent. Complete ONLY the assigned prompt.\nDo not ask the user questions; do the work and report back.\nThe task tool is not available. Do not try to spawn more subagents.\nReturn a concise report: what you did, files changed, and any blockers.`,
    },
    { role: 'user', content: prompt },
  ];
  const tools = runtime.registry.definitions((tool) => !PARENT_ONLY.has(tool.name));
  let lastText = '';
  let finished = false;
  let streamFailures = 0;
  const turnLimit = Math.max(1, Math.min(500, Number(maxTurns) || 40));

  for (let turn = 1; turn <= turnLimit; turn++) {
    if (signal?.aborted) break;
    emit('running', { detail: `turn ${turn}` });
    let result;
    try {
      result = await chatWithTools({
        client,
        model,
        messages,
        tools,
        temperature,
        reasoningEffort,
        signal,
      });
      streamFailures = 0;
    } catch (error) {
      streamFailures += 1;
      const message = String(error?.message || error);
      const retry = streamFailures <= 2 && !signal?.aborted && (error?.partialOutput ? false : isRetryableMessage(message, error));
      if (retry) {
        emit('running', { detail: `retry ${streamFailures}/2 · ${message.slice(0, 120)}` });
        ui?.onNotice?.(`서브에이전트 연결이 끊겨 다시 시도합니다 (${streamFailures}/2)`, 'warning');
        messages.push({
          role: 'user',
          content: `The previous model request failed (${message.slice(0, 400)}). Continue the assigned task and return a concise final report. Do not stop.`,
        });
        await sleep(500 * streamFailures);
        continue;
      }
      emit('error', { detail: message.slice(0, 180), result: message.slice(0, 4000) });
      return { error: message.slice(0, 4000), title };
    }
    if (result.tool_calls?.length) {
      messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.tool_calls });
      for (const call of result.tool_calls) {
        if (signal?.aborted) break;
        const name = call.function?.name;
        const parsed = parseToolArguments(runtime.registry, name, call.function?.arguments);
        let toolResult;
        if (!parsed.ok) {
          toolResult = { error: parsed.error.message, code: parsed.error.code };
        } else if (PARENT_ONLY.has(name)) {
          toolResult = { error: name === 'task' ? 'Subagents cannot spawn more subagents.' : 'Subagents cannot ask the user questions.' };
        } else if (gate.requiresApproval(name, parsed.args) && !(await gate.approve(name, runtime.detailFor(name, parsed.args), { signal, args: parsed.args }))) {
          toolResult = { error: 'User denied this tool call.', code: 'permission_denied' };
        } else {
          emit('running', { detail: `${name} ${runtime.detailFor(name, parsed.args)}`.slice(0, 160) });
          toolResult = await runtime.execute(name, parsed.args, { signal, callId: call.id });
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(toolResult).slice(0, 80_000),
        });
      }
      continue;
    }
    lastText = result.content || '';
    finished = true;
    break;
  }

  if (!lastText.trim()) {
    lastText = signal?.aborted
      ? 'Subagent stopped before finishing.'
      : finished
        ? 'Subagent finished with no summary.'
        : 'Subagent reached the turn limit.';
  }
  const status = signal?.aborted ? 'aborted' : finished ? 'done' : 'error';
  emit(status, { detail: status, result: lastText.slice(0, 8000) });
  if (signal?.aborted) return { error: 'aborted', title, result: lastText };
  if (!finished) return { error: 'turn limit', title, result: lastText };
  return { ok: true, title, result: lastText };
}

function isRetryableMessage(message, error) {
  try {
    return isRetryableProviderError(error);
  } catch {
    return /timeout|network|disconnect|socket|ECONNRESET/i.test(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
