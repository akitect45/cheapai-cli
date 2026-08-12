import crypto from 'node:crypto';
import { chatWithTools } from '../llm/client.js';
import {
  classifyProviderError,
  isRetryableProviderError,
  providerRetryDelayMs,
  DEFAULT_PROVIDER_MAX_RETRIES,
} from '../llm/errors.js';
import { createPermissionGate } from './permissions.js';
import { beginTurn, finishTurn, recordBash, recordFileChange } from './history.js';
import { saveSession, appendSessionEntry } from './session.js';
import { mergeSessionUsage, normalizeUsage } from './usage.js';
import { createEventStream } from './events.js';
import { createOperationJournal } from './operation-journal.js';
import { createToolRuntime } from './tools.js';
import { parseToolArguments } from './tool-contract.js';

const GOAL_TOOL_NAMES = new Set(['read_file', 'glob', 'grep', 'todo_write']);

export function createAgentRuntime(options = {}) {
  const {
    client,
    model,
    session,
    permissionMode = 'ask',
    maxTurns = 0,
    temperature = 0.2,
    reasoningEffort = null,
    showThinking = true,
    goalMode = false,
    print = false,
    alwaysApprove = false,
    onPermissionModeChange = null,
    requestPermission = null,
    ui = null,
    signal = null,
    pathMode = alwaysApprove || permissionMode === 'yolo' ? 'unrestricted' : 'workspace',
    extraRoots = [],
    middleware = {},
    maxRetries = DEFAULT_PROVIDER_MAX_RETRIES,
    maxTokens = 0,
    timeBudgetMs = 0,
    customTools = [],
    eventHooks = null,
  } = options;
  const runId = crypto.randomUUID();
  const events = createEventStream({ sessionId: session?.id, runId });
  if (eventHooks?.entries) {
    for (const [eventName, handlers] of eventHooks.entries()) {
      for (const entry of handlers) {
        events.subscribe((event) => {
          if (event.type !== eventName) return;
          Promise.resolve(entry.handler(event)).catch(() => {});
        });
      }
    }
  }
  const steeringQueue = [];
  const followUpQueue = [];
  let active = false;
  let controller = null;
  let currentTurnId = null;
  let allowAll = alwaysApprove;
  let turnOpen = false;
  let messageOpen = false;

  const api = {
    events,
    subscribe(listener) {
      return events.subscribe(listener);
    },
    enqueueSteering(text) {
      if (text == null || !String(text).trim()) return false;
      steeringQueue.push(String(text).trim());
      return true;
    },
    enqueueFollowUp(text) {
      if (text == null || !String(text).trim()) return false;
      followUpQueue.push(String(text).trim());
      return true;
    },
    /** Move waiting follow-ups into the mid-run steering queue (inject after the current tool batch / reply). */
    promoteFollowUpsToSteering() {
      const items = followUpQueue.splice(0);
      for (const item of items) steeringQueue.push(item);
      return items.length;
    },
    queueSnapshot() {
      return {
        followUps: [...followUpQueue],
        steering: [...steeringQueue],
      };
    },
    abort() {
      controller?.abort();
    },
    get active() {
      return active;
    },
    async run(userText) {
      if (active) throw new Error('An agent run is already active for this runtime.');
      active = true;
      turnOpen = false;
      messageOpen = false;
      const linked = linkedAbortController(signal);
      controller = linked.controller;
      const budgetTimer = timeBudgetMs > 0
        ? setTimeout(() => controller.abort(), Math.max(1, Number(timeBudgetMs)))
        : null;
      budgetTimer?.unref?.();
      const checkpoint = beginTurn(session);
      currentTurnId = checkpoint.id;
      const journal = createOperationJournal({
        sessionId: session.id,
        onRecord: (record) => {
          try {
            appendSessionEntry(session, 'operation', record);
          } catch {
            // The operation journal remains authoritative if the session write is unavailable.
          }
        },
      });
      const recoveredOperations = journal.recover();
      if (reconcileUncertainOperations(session, recoveredOperations)) saveSession(session);
      const runtime = createToolRuntime({
        cwd: session.cwd || process.cwd(),
        pathMode,
        extraRoots,
        customTools,
        onTodo: (todos) => {
          if (ui?.onTodo) ui.onTodo(todos);
          else if (!print) process.stdout.write(`\x1b[2m  todos: ${todos.map((t) => `${t.status[0]}:${t.id}`).join(' ')}\x1b[0m\n`);
        },
        onFileChange: (change) => recordFileChange(checkpoint, change),
        onBash: (command) => recordBash(checkpoint, command),
      });
      let gate = createPermissionGate(allowAll ? 'yolo' : permissionMode, requestPermission, {
        interactive: !print && process.stdin.isTTY && process.stdout.isTTY,
        allowTodo: goalMode,
        toolResolver: (name) => runtime.registry.get(name),
      });
      const runSignal = controller.signal;
      let finalText = '';
      let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_credits: 0, cost_usd: 0 };
      let completed = false;
      emit('agent_start', { model: session.model || model });
      try {
        const content = Array.isArray(userText) ? userText : String(userText || '');
        const titleText = Array.isArray(content) ? content.map((part) => part?.text || '').join(' ') : content;
        session.messages.push({ role: 'user', content });
        if (!session.title) session.title = sessionTitle(titleText);
        saveSession(session);

        // maxTurns <= 0 means unlimited tool loops.
        const turnLimit = Number(maxTurns) > 0 ? Number(maxTurns) : Number.POSITIVE_INFINITY;
        for (let turn = 1; turn <= turnLimit; turn++) {
          if (runSignal.aborted) throw abortError();
          const turnId = turn === 1 ? checkpoint.id : crypto.randomUUID();
          currentTurnId = turnId;
          emit('turn_start', { turn }, { turnId });
          if (ui?.onThinking) ui.onThinking(turn);
          else if (!print) process.stdout.write(`\x1b[2m\n● thinking (turn ${turn})…\x1b[0m\n`);

          let startedAssistant = false;
          let renderedAssistant = false;
          const stream = await streamTurnWithRetries({
            client,
            model: session.model || model,
            messages: session.messages,
            tools: runtime.registry.definitions((tool) => !goalMode || GOAL_TOOL_NAMES.has(tool.name)),
            temperature,
            reasoningEffort,
            signal: runSignal,
            maxRetries,
            print,
            ui,
            emit,
            turnId,
            showThinking,
          });
          const result = stream.result;
          startedAssistant = stream.startedAssistant;
          renderedAssistant = stream.renderedAssistant;

          if (result.usage) {
            const usage = normalizeUsage(result.usage);
            totalUsage.prompt_tokens += usage.inputTokens;
            totalUsage.completion_tokens += usage.outputTokens;
            totalUsage.total_tokens += usage.totalTokens;
            totalUsage.cost_credits += usage.credits;
            totalUsage.cost_usd += usage.usd;
            totalUsage.cost_krw = totalUsage.cost_credits;
            totalUsage.last_prompt_tokens = usage.inputTokens;
            totalUsage.last_completion_tokens = usage.outputTokens;
            session.usage = mergeSessionUsage(session.usage, result.usage);
            session.lastContextTokens = usage.inputTokens;
            saveSession(session);
          }
          if (maxTokens > 0 && totalUsage.total_tokens >= maxTokens) {
            finalText = '(token budget reached)';
            if (!messageOpen) emit('message_start', { role: 'assistant' }, { turnId });
            appendAssistant(session, finalText, 'budget');
            emit('message_end', { role: 'assistant', content: finalText, status: 'budget' }, { turnId });
            emit('turn_end', { turn, status: 'budget' }, { turnId });
            break;
          }

          if (result.tool_calls?.length) {
            session.messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.tool_calls });
            saveSession(session);
            if (!startedAssistant) {
              startedAssistant = true;
              emit('message_start', { role: 'assistant', content: result.content || '' }, { turnId });
            }
            emit('message_end', { role: 'assistant', content: result.content || '' }, { turnId });
            if (renderedAssistant) {
              ui?.onAssistantEnd?.();
              if (!ui?.onAssistantEnd && !print) process.stdout.write('\n');
            }
            const toolResults = await executeToolBatch({
              calls: result.tool_calls,
              runtime,
              gate,
              journal,
              session,
              turnId,
              runSignal,
              goalMode,
              alwaysApprove: allowAll,
              print,
              ui,
              middleware,
              onPermissionModeChange: (nextMode) => {
                allowAll = true;
                gate = createPermissionGate('yolo', requestPermission, {
                  interactive: !print && process.stdin.isTTY && process.stdout.isTTY,
                  allowTodo: goalMode,
                  toolResolver: (name) => runtime.registry.get(name),
                });
                onPermissionModeChange?.(nextMode);
              },
              emitEvent: emit,
            });
            for (const item of toolResults) {
              session.messages.push({
                role: 'tool',
                tool_call_id: item.call.id,
                content: JSON.stringify(item.result).slice(0, 80_000),
              });
            }
            saveSession(session);
            emit('turn_end', { turn, status: 'tool_calls' }, { turnId });
            addQueuedMessages(session, steeringQueue.splice(0), 'steering');
            continue;
          }

          finalText = result.content || '';
          if (!startedAssistant) {
            startedAssistant = true;
            emit('message_start', { role: 'assistant' }, { turnId });
          }
          appendAssistant(session, finalText, 'completed');
          emit('message_end', { role: 'assistant', content: finalText }, { turnId });
          if (renderedAssistant) {
            ui?.onAssistantEnd?.();
            if (!ui?.onAssistantEnd && !print) process.stdout.write('\n');
          } else if (finalText) {
            renderedAssistant = true;
            ui?.onAssistantStart?.();
            ui?.onDelta?.(finalText);
            ui?.onAssistantEnd?.();
            if (!ui?.onDelta && !print) process.stdout.write(finalText + '\n');
            if (!ui?.onDelta && print) process.stdout.write(finalText + '\n');
          }
          emit('turn_end', { turn, status: 'completed' }, { turnId });
          const steering = steeringQueue.splice(0);
          if (steering.length) {
            addQueuedMessages(session, steering, 'steering');
            continue;
          }
          const followUps = followUpQueue.splice(0);
          if (followUps.length) {
            addQueuedMessages(session, followUps, 'follow_up');
            continue;
          }
          completed = true;
          break;
        }

        if (!completed && !finalText) {
          finalText = '(max turns reached without final answer)';
          appendAssistant(session, finalText, 'max_turns');
          ui?.onNotice?.(finalText, 'warning');
          if (!print && !ui?.onNotice) console.log(`\x1b[33m${finalText}\x1b[0m`);
        }
        emit('agent_end', { status: completed ? 'completed' : 'stopped', text: finalText });
        finishTurn(session, checkpoint);
        return { text: finalText, session, usage: totalUsage, contextTokens: session.lastContextTokens || 0 };
      } catch (error) {
        const aborted = error?.name === 'AbortError' || runSignal.aborted;
        const status = aborted ? 'aborted' : 'error';
        if (aborted) finalText = '(generation aborted)';
        if (turnOpen && !messageOpen) emit('message_start', { role: 'assistant', status }, { turnId: currentTurnId });
        if (messageOpen) emit('message_end', { role: 'assistant', content: finalText, status }, { turnId: currentTurnId });
        if (turnOpen) emit('turn_end', { status }, { turnId: currentTurnId });
        if (aborted) {
          appendAssistant(session, finalText, 'aborted');
          emit('agent_end', { status: 'aborted', error: error.message });
        } else {
          emit('notice', { message: error.message || String(error), level: 'error' });
          emit('agent_end', { status: 'error', error: error.message || String(error) });
        }
        finishTurn(session, checkpoint);
        throw error;
      } finally {
        clearTimeout(budgetTimer);
        linked.dispose();
        controller = null;
        currentTurnId = null;
        active = false;
      }
    },
  };

  return api;

  function emit(type, data, ids = {}) {
    const event = events.emit(type, data, { turnId: currentTurnId, ...ids });
    if (type === 'turn_start') turnOpen = true;
    else if (type === 'message_start') messageOpen = true;
    else if (type === 'message_end') messageOpen = false;
    else if (type === 'turn_end') turnOpen = false;
    return event;
  }
}

async function executeToolBatch({
  calls,
  runtime,
  gate,
  journal,
  session,
  turnId,
  runSignal,
  goalMode,
  alwaysApprove,
  print,
  ui,
  middleware,
  onPermissionModeChange,
  emitEvent,
}) {
  const prepared = [];
  let permitAll = alwaysApprove;
  for (const [callIndex, call] of calls.entries()) {
    const name = call.function?.name;
    const parsed = parseToolArguments(runtime.registry, name, call.function?.arguments);
    let args = parsed.ok ? parsed.args : null;
    let error = parsed.ok ? null : parsed.error;
    const tool = parsed.tool || runtime.registry.get(name);
    if (parsed.ok && goalMode && !GOAL_TOOL_NAMES.has(name)) {
      error = { code: 'goal_mode_denied', message: 'Goal mode allows only read, search, and todo tools.' };
    }
    if (parsed.ok && !error) {
      try {
        for (const before of middleware.before || []) {
          const changed = await before({ callId: call.id, name, args, tool, session, cwd: runtime.root, signal: runSignal });
          if (changed?.args) args = changed.args;
        }
        const revalidated = runtime.registry.validate(name, args);
        if (!revalidated.ok) error = revalidated.error;
      } catch (hookError) {
        error = { code: 'tool_preflight_error', message: String(hookError?.message || hookError) };
      }
    }
    const detail = runtime.detailFor(name, args || {});
    const meta = {
      callId: call.id || `${turnId}:${callIndex}`,
      batchId: turnId,
      batchCount: calls.length,
      batchIndex: callIndex,
    };
    emitEvent('tool_preflight', { name, detail, error }, { turnId });
    if (!error && !permitAll && gate.requiresApproval(name)) {
      if (ui?.onToolPending) ui.onToolPending(name, detail, meta);
      else if (!print) console.log(`\x1b[33m\n○ ${name} · approval required\x1b[0m \x1b[2m${String(detail).slice(0, 120)}\x1b[0m`);
      const decision = await gate.approve(name, detail, { signal: runSignal });
      if (decision === 'always') {
        permitAll = true;
        onPermissionModeChange?.('yolo');
      } else if (!decision) {
        error = { code: 'permission_denied', message: 'User denied this tool call.' };
      }
    }
    prepared.push({ call, name, args, tool, error, detail, meta });
  }

  ui?.onToolBatch?.(prepared.map(({ name, detail, meta }) => ({ name, detail, ...meta })), {
    batchId: turnId,
    batchCount: prepared.length,
  });

  const results = [];
  for (let index = 0; index < prepared.length;) {
    const current = prepared[index];
    const parallel = current.tool?.execution === 'parallel';
    const group = [];
    while (index < prepared.length && (prepared[index].tool?.execution === 'parallel') === parallel) group.push(prepared[index++]);
    const groupResults = parallel
      ? await Promise.all(group.map((item) => executeOne(item)))
      : [];
    if (!parallel) {
      for (const item of group) groupResults.push(await executeOne(item));
    }
    results.push(...groupResults);
  }
  return results;

  async function executeOne(item) {
    const { call, name, args, tool, error, detail, meta } = item;
    if (runSignal.aborted) throw abortError();
    if (error) {
      const result = { error: error.message, code: error.code };
      ui?.onToolEnd?.(name, detail, 'error', result, meta);
      return { call, result, status: 'error' };
    }
    const operationId = `${turnId}:${call.id}`;
    const operation = tool.sideEffect === 'none'
      ? { execute: true, record: null, result: null }
      : journal.begin({ operationId, tool: name, args });
    if (!operation.execute) {
      const result = operation.result || { error: 'Operation was uncertain and was not replayed.', code: operation.record?.state };
      ui?.onToolEnd?.(name, detail, operation.record?.state === 'completed' ? 'ok' : 'error', result, meta);
      return { call, result, status: operation.record?.state === 'completed' ? 'ok' : 'error' };
    }
    emitEvent('tool_start', { name, detail }, { turnId });
    ui?.onToolStart?.(name, detail, meta);
    if (!ui?.onToolStart && !print) console.log(`\x1b[33m\n● ${name} · running\x1b[0m`);
    let result;
    let status = 'ok';
    try {
      result = await runtime.execute(name, args, {
        signal: runSignal,
        callId: operationId,
        onUpdate: (data) => emitEvent('tool_update', { name, ...data }, { turnId }),
        onProcess: (processRecord) => journal.processStarted(operationId, processRecord),
      });
      for (const after of middleware.after || []) {
        const changed = await after({ callId: call.id, name, args, tool, result, session, cwd: runtime.root, signal: runSignal });
        if (changed?.result !== undefined) result = changed.result;
      }
      if (result?.error || result?.ok === false) status = 'error';
      if (tool.sideEffect !== 'none') {
        if (status === 'ok') journal.complete(operationId, result);
        else journal.fail(operationId, result);
      }
    } catch (caught) {
      result = { error: String(caught?.message || caught), code: caught?.code || 'tool_error' };
      status = 'error';
      if (tool.sideEffect !== 'none') journal.fail(operationId, result);
    }
    emitEvent('tool_end', { name, detail, status, result }, { turnId });
    ui?.onToolEnd?.(name, detail, status, result, meta);
    if (!ui?.onToolEnd && !print) {
      const mark = status === 'ok' ? '\x1b[32m  ✓ done\x1b[0m' : '\x1b[33m  · done\x1b[0m';
      console.log(mark);
    }
    return { call, result, status };
  }
}

function addQueuedMessages(session, values, source) {
  for (const value of values) session.messages.push({ role: 'user', content: value, cheapai_source: source });
  if (values.length) saveSession(session);
}

function appendAssistant(session, content, status) {
  session.messages.push({ role: 'assistant', content, cheapai_status: status });
  saveSession(session);
}

function reconcileUncertainOperations(session, records) {
  const uncertainCalls = new Map();
  for (const record of records || []) {
    const callId = String(record.operationId || '').split(':').at(-1);
    if (callId) uncertainCalls.set(callId, record);
  }
  if (!uncertainCalls.size) return false;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const rebuilt = [];
  let changed = false;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    rebuilt.push(message);
    if (message?.role !== 'assistant' || !message.tool_calls?.length) continue;
    const existing = new Set();
    while (messages[index + 1]?.role === 'tool') {
      const toolMessage = messages[++index];
      rebuilt.push(toolMessage);
      if (toolMessage.tool_call_id) existing.add(toolMessage.tool_call_id);
    }
    for (const call of message.tool_calls) {
      if (!uncertainCalls.has(call.id) || existing.has(call.id)) continue;
      rebuilt.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify({
          error: 'Previous tool operation was interrupted and was not replayed.',
          code: 'operation_uncertain',
          operation_id: uncertainCalls.get(call.id).operationId,
        }),
      });
      changed = true;
    }
  }
  if (changed) session.messages = rebuilt;
  return changed;
}

/**
 * Provider-level retries cover pre-stream / clean failures.
 * Mid-stream disconnects after visible text set partialOutput and need a turn-level
 * replay that clears the incomplete assistant bubble first.
 */
async function streamTurnWithRetries({
  client,
  model,
  messages,
  tools,
  temperature,
  reasoningEffort,
  signal,
  maxRetries,
  print,
  ui,
  emit,
  turnId,
  showThinking,
}) {
  const retryBudget = Math.max(0, Number(maxRetries) || 0);
  for (let attempt = 0; ; attempt++) {
    let startedAssistant = false;
    let renderedAssistant = false;
    try {
      const result = await chatWithTools({
        client,
        model,
        messages,
        tools,
        temperature,
        reasoningEffort,
        signal,
        maxRetries,
        onRetry: ({ attempt: providerAttempt, maxRetries: budget, waitMs, classification }) => {
          const seconds = Math.max(1, Math.ceil((waitMs || 0) / 1000));
          const kind = classification?.category === 'rate_limit'
            ? 'rate limited'
            : classification?.category || 'error';
          const text = `Provider ${kind} — retry ${providerAttempt}/${budget} in ${seconds}s…`;
          ui?.onNotice?.(text, 'warning');
          if (!ui?.onNotice && !print) console.log(`\x1b[33m  ${text}\x1b[0m`);
        },
        onThinking: (delta) => {
          emit('reasoning_delta', { delta }, { turnId });
          if (showThinking) {
            if (ui?.onReasoningDelta) ui.onReasoningDelta(delta);
            else if (!print) process.stdout.write(`\x1b[2m${delta}\x1b[0m`);
          }
        },
        onDelta: (delta) => {
          if (!startedAssistant) {
            startedAssistant = true;
            renderedAssistant = true;
            emit('message_start', { role: 'assistant' }, { turnId });
            ui?.onAssistantStart?.();
          }
          emit('message_delta', { delta }, { turnId });
          if (ui?.onDelta) ui.onDelta(delta);
          else process.stdout.write(delta);
        },
      });
      return { result, startedAssistant, renderedAssistant };
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      // Non-partial failures are already retried inside the provider stream().
      if (!error?.partialOutput || !isRetryableProviderError(error) || attempt >= retryBudget) throw error;

      if (renderedAssistant) ui?.onAssistantRetry?.();
      const classification = classifyProviderError(error);
      const waitMs = providerRetryDelayMs(attempt, { retryAfterMs: classification.retryAfterMs });
      const seconds = Math.max(1, Math.ceil(waitMs / 1000));
      const text = `Stream interrupted — retrying (${attempt + 1}/${retryBudget}) in ${seconds}s…`;
      ui?.onNotice?.(text, 'warning');
      if (!ui?.onNotice && !print) console.log(`\x1b[33m  ${text}\x1b[0m`);
      if (waitMs > 0) await delayWithSignal(waitMs, signal);
    }
  }
}

function delayWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function linkedAbortController(parent) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return {
    controller,
    dispose() {
      parent?.removeEventListener('abort', abort);
    },
  };
}

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function sessionTitle(value) {
  const clean = String(value || '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...(clean || 'Untitled session')].slice(0, 80).join('');
}
