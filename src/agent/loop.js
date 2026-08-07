import { chatWithTools } from '../llm/client.js';
import { TOOL_DEFINITIONS, createToolRuntime } from './tools.js';
import { createPermissionGate } from './permissions.js';
import { saveSession } from './session.js';

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
  print = false,
  alwaysApprove = false,
  ui = null,
}) {
  const cwd = session.cwd || process.cwd();
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
  });
  let gate = createPermissionGate(alwaysApprove ? 'yolo' : permissionMode);

  session.messages.push({ role: 'user', content: userText });
  if (!session.title) session.title = userText.slice(0, 80);

  let finalText = '';
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (ui?.onThinking) ui.onThinking(turn);
    else if (!print) process.stdout.write(`\x1b[2m\n● thinking (turn ${turn})…\x1b[0m\n`);

    let startedAssistant = false;
    const result = await chatWithTools({
      client,
      model: session.model || model,
      messages: session.messages,
      tools: TOOL_DEFINITIONS,
      temperature,
      reasoningEffort,
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
      totalUsage.prompt_tokens += result.usage.prompt_tokens || 0;
      totalUsage.completion_tokens += result.usage.completion_tokens || 0;
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

        if (ui?.onToolStart) ui.onToolStart(name, detail);
        else if (!print) {
          console.log(`\x1b[36m\n⚙ ${name}\x1b[0m \x1b[2m${String(detail).slice(0, 120)}\x1b[0m`);
        }

        let allowed = alwaysApprove;
        if (!allowed) {
          const decision = await gate.approve(name, detail);
          if (decision === 'always') {
            alwaysApprove = true;
            gate = createPermissionGate('yolo');
            allowed = true;
          } else {
            allowed = !!decision;
          }
        }

        let toolResult;
        let status = 'ok';
        if (!allowed) {
          toolResult = { error: 'User denied this tool call.' };
          status = 'denied';
        } else {
          try {
            toolResult = await runtime.execute(name, args);
            if (toolResult?.error || toolResult?.ok === false) status = 'error';
          } catch (err) {
            toolResult = { error: String(err?.message || err) };
            status = 'error';
          }
        }

        if (ui?.onToolEnd) ui.onToolEnd(name, detail, status);
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

  if (!finalText && session.messages.at(-1)?.role !== 'assistant') {
    finalText = '(max turns reached without final answer)';
    if (!print) console.log(`\x1b[33m${finalText}\x1b[0m`);
  }

  return { text: finalText, session, usage: totalUsage };
}
