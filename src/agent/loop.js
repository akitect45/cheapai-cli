import { chatWithTools } from '../llm/client.js';
import { TOOL_DEFINITIONS, createToolRuntime } from './tools.js';
import { createPermissionGate } from './permissions.js';
import { saveSession } from './session.js';
import { mergeSessionUsage, normalizeUsage } from './usage.js';
import { beginTurn, finishTurn, recordBash, recordFileChange } from './history.js';

const GOAL_TOOL_NAMES = new Set(['read_file', 'glob', 'grep', 'todo_write']);

export function toolsForMode(goalMode = false) {
  return goalMode
    ? TOOL_DEFINITIONS.filter((tool) => GOAL_TOOL_NAMES.has(tool.function.name))
    : TOOL_DEFINITIONS;
}

/**
 * Run agent until final text or max turns.
 * @param {object} opts
 * @param {object} [opts.ui] optional TUI hooks { onThinking, onDelta, onToolStart, onToolEnd, onAssistantStart, onAssistantEnd }
 */
export async function runAgentLoop({
  client,
  model,
  session,
  userText,
  permissionMode = 'ask',
  maxTurns = 40,
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
}) {
  const cwd = session.cwd || process.cwd();
  const checkpoint = beginTurn(session);
  const runtime = createToolRuntime({
    cwd,
    onTodo: (todos) => {
      if (ui?.onTodo) ui.onTodo(todos);
      else if (!print) {
        process.stdout.write(
          `\x1b[2m  todos: ${todos.map((t) => `${t.status[0]}:${t.id}`).join(' ')}\x1b[0m\n`,
        );
      }
    },
    onFileChange: (change) => recordFileChange(checkpoint, change),
    onBash: (command) => recordBash(checkpoint, command),
  });
  let gate = createPermissionGate(alwaysApprove ? 'yolo' : permissionMode, requestPermission, {
    interactive: !print && process.stdin.isTTY && process.stdout.isTTY,
    allowTodo: goalMode,
  });

  session.messages.push({ role: 'user', content: userText });
  if (!session.title) session.title = sessionTitle(userText);

  let finalText = '';
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_credits: 0, cost_usd: 0 };

  try {
  for (let turn = 1; turn <= maxTurns; turn++) {
    if (ui?.onThinking) ui.onThinking(turn);
    else if (!print) process.stdout.write(`\x1b[2m\n● thinking (turn ${turn})…\x1b[0m\n`);

    let startedAssistant = false;
    const result = await chatWithTools({
      client,
      model: session.model || model,
      messages: session.messages,
      tools: toolsForMode(goalMode),
      temperature,
      reasoningEffort,
      signal,
      onThinking: (d) => {
        if (showThinking) {
          if (ui?.onReasoningDelta) ui.onReasoningDelta(d);
          else if (!print) process.stdout.write(`\x1b[2m${d}\x1b[0m`);
        }
      },
      onDelta: (d) => {
        if (!startedAssistant) {
          startedAssistant = true;
          if (ui?.onAssistantStart) ui.onAssistantStart();
        }
        if (ui?.onDelta) ui.onDelta(d);
        else process.stdout.write(d);
      },
    });

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

    if (result.tool_calls?.length) {
      session.messages.push({
        role: 'assistant',
        content: result.content || null,
        tool_calls: result.tool_calls,
      });
      if (startedAssistant) {
        if (ui?.onAssistantEnd) ui.onAssistantEnd();
        else if (!print) process.stdout.write('\n');
      }

      for (const tc of result.tool_calls) {
        const name = tc.function.name;
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          args = {};
        }
        const detail = runtime.detailFor(name, args);

        const blockedByGoal = goalMode && !GOAL_TOOL_NAMES.has(name);
        let allowed = !blockedByGoal && alwaysApprove;
        if (!blockedByGoal && !allowed) {
          if (gate.requiresApproval(name)) {
            if (ui?.onToolPending) ui.onToolPending(name, detail);
            else if (!print) {
              console.log(`\x1b[33m\n○ ${name} · approval required\x1b[0m \x1b[2m${String(detail).slice(0, 120)}\x1b[0m`);
            }
          }
          const decision = await gate.approve(name, detail);
          if (decision === 'always') {
            alwaysApprove = true;
            gate = createPermissionGate('yolo', requestPermission, {
              interactive: !print && process.stdin.isTTY && process.stdout.isTTY,
              allowTodo: goalMode,
            });
            onPermissionModeChange?.('yolo');
            allowed = true;
          } else {
            allowed = !!decision;
          }
        }

        let toolResult;
        let status = 'ok';
        if (!allowed) {
          toolResult = { error: blockedByGoal ? 'Goal mode allows only read, search, and todo tools.' : 'User denied this tool call.' };
          status = 'denied';
        } else {
          if (ui?.onToolStart) ui.onToolStart(name, detail);
          else if (!print) console.log(`\x1b[33m\n● ${name} · running\x1b[0m`);
          try {
            toolResult = await runtime.execute(name, args, { signal });
            if (toolResult?.error || toolResult?.ok === false) status = 'error';
          } catch (err) {
            toolResult = { error: String(err?.message || err) };
            status = 'error';
          }
        }

        if (ui?.onToolEnd) ui.onToolEnd(name, detail, status, toolResult);
        else if (!print) {
          const mark = status === 'ok' ? '\x1b[32m  ✓ done\x1b[0m' : status === 'denied' ? '\x1b[31m  ✗ denied\x1b[0m' : '\x1b[33m  · done\x1b[0m';
          console.log(mark);
        }

        session.messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(toolResult).slice(0, 80_000),
        });
      }
      saveSession(session);
      continue;
    }

    finalText = result.content || '';
    session.messages.push({ role: 'assistant', content: finalText });
    saveSession(session);
    if (startedAssistant) {
      if (ui?.onAssistantEnd) ui.onAssistantEnd();
      else if (!print) process.stdout.write('\n');
    } else if (finalText) {
      // no stream deltas? still print
      if (ui?.onAssistantStart) ui.onAssistantStart();
      if (ui?.onDelta) ui.onDelta(finalText);
      if (ui?.onAssistantEnd) ui.onAssistantEnd();
      else process.stdout.write(finalText + '\n');
    }
    break;
  }
  } catch (error) {
    finishTurn(session, checkpoint);
    throw error;
  }

  if (!finalText && session.messages.at(-1)?.role !== 'assistant') {
    finalText = '(max turns reached without final answer)';
    if (ui?.onNotice) ui.onNotice(finalText, 'warning');
    else if (!print) console.log(`\x1b[33m${finalText}\x1b[0m`);
  }

  finishTurn(session, checkpoint);
  return { text: finalText, session, usage: totalUsage, contextTokens: session.lastContextTokens || 0 };
}

function sessionTitle(value) {
  const clean = String(value)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...(clean || 'Untitled session')].slice(0, 80).join('');
}
