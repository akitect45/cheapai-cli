import { saveSession } from './session.js';
import { estimateMessagesTokens, mergeSessionUsage } from './usage.js';
import { getProvider } from '../llm/providers.js';

const SUMMARY_MAX_CHARS = 120_000;
const MESSAGE_MAX_CHARS = 14_000;
const MIN_SOURCE_TOKENS = 1200;

export async function compactSession({ client, model, session }) {
  const system = session.messages?.find((message) => message?.role === 'system') || {
    role: 'system',
    content: '',
  };
  const conversation = (session.messages || []).filter((message) => message?.role !== 'system');
  const beforeTokens = estimateMessagesTokens(session.messages || []);
  const lastUserIndex = findLastIndex(conversation, (message) => message?.role === 'user');
  const sourceMessages = conversation.slice(0, lastUserIndex);
  const sourceTokens = estimateMessagesTokens(sourceMessages);

  if (conversation.length < 3 || lastUserIndex < 1 || sourceTokens < MIN_SOURCE_TOKENS) {
    return { compacted: false, reason: 'Conversation is too short to compact.', beforeTokens, afterTokens: beforeTokens };
  }

  const transcript = serializeConversation(sourceMessages);
  const response = await getProvider('openai-compatible').complete({
    client,
    model,
    messages: [
      {
        role: 'system',
        content: [
          'You compact coding-agent conversations for a future continuation.',
          'Return only a detailed plain-text summary, without preamble or markdown fences.',
          'Preserve the user goal, acceptance criteria, decisions, constraints, files changed,',
          'important code facts, commands and test results, unresolved issues, and the next action.',
          'Do not invent facts. Keep exact paths, identifiers, errors, and numbers when present.',
        ].join(' '),
      },
      { role: 'user', content: `Conversation to compact:\n\n${transcript}` },
    ],
    temperature: 0.1,
    maxTokens: Math.min(3200, Math.max(512, Math.floor(sourceTokens * 0.25))),
  });
  const summary = messageText(response.choices?.[0]?.message?.content).trim();
  if (!summary) throw new Error('Compaction returned an empty summary.');

  const tail = conversation.slice(lastUserIndex);
  const summaryPrompt = [
    '[Previous conversation summary]',
    summary,
    '',
    'Use this summary as working context. The most recent exchange follows it.',
  ].join('\n');
  const compactedMessages = [
    system,
    { role: 'user', content: summaryPrompt },
    { role: 'assistant', content: 'Context loaded. I will continue from this summary.' },
    ...tail,
  ];
  const afterTokens = estimateMessagesTokens(compactedMessages);
  if (afterTokens >= beforeTokens) {
    if (response.usage) session.usage = mergeSessionUsage(session.usage, response.usage);
    saveSession(session);
    return {
      compacted: false,
      reason: 'Summary did not reduce context; session was left unchanged.',
      beforeTokens,
      afterTokens,
      summaryUsage: response.usage || null,
    };
  }
  session.messages = compactedMessages;
  session.undoStack = [];
  session.redoStack = [];
  session.compactions = [
    ...(Array.isArray(session.compactions) ? session.compactions : []),
    {
      at: new Date().toISOString(),
      beforeTokens,
      afterTokens,
      keptMessages: tail.length,
    },
  ].slice(-20);
  if (response.usage) session.usage = mergeSessionUsage(session.usage, response.usage);
  session.lastContextTokens = afterTokens;
  saveSession(session);

  return {
    compacted: true,
    beforeTokens,
    afterTokens,
    keptMessages: tail.length,
    summaryUsage: response.usage || null,
  };
}

function serializeConversation(messages) {
  const blocks = messages.map(serializeMessage);
  const full = blocks.join('\n\n');
  if (full.length <= SUMMARY_MAX_CHARS) return full;

  const anchors = blocks.slice(0, 2);
  const recent = [];
  const marker = '[Middle oversized content omitted; prioritize the initial goal and recent state.]';
  let remaining = SUMMARY_MAX_CHARS
    - anchors.reduce((sum, block) => sum + block.length + 2, 0)
    - marker.length
    - 4;
  for (let index = blocks.length - 1; index >= anchors.length; index--) {
    const block = blocks[index];
    if (block.length + 2 > remaining) continue;
    recent.unshift(block);
    remaining -= block.length + 2;
  }
  return [...anchors, marker, ...recent].join('\n\n');
}

function serializeMessage(message) {
  const role = String(message?.role || 'message').toUpperCase();
  const content = messageText(message?.content);
  const calls = (message?.tool_calls || [])
    .map((call) => `${call?.function?.name || 'tool'}(${call?.function?.arguments || ''})`)
    .join('\n');
  const value = [content, calls].filter(Boolean).join('\n');
  return `${role}: ${clip(value || '(empty)', MESSAGE_MAX_CHARS)}`;
}

function messageText(content) {
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.text || part?.content || '')
      .filter(Boolean)
      .join('');
  }
  return typeof content === 'string' ? content : content == null ? '' : JSON.stringify(content);
}

function clip(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n[…truncated…]` : text;
}

function findLastIndex(values, predicate) {
  for (let index = values.length - 1; index >= 0; index--) {
    if (predicate(values[index])) return index;
  }
  return -1;
}
