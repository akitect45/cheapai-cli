import crypto from 'node:crypto';
import { chatWithTools } from '../llm/client.js';

const FALLBACK = [
  { id: 'verify', text: '이 결과에서 아직 검증되지 않은 부분을 점검해줘.', intent: 'verify' },
  { id: 'gap', text: '빠진 예외 처리와 사용자 흐름을 찾아줘.', intent: 'gap' },
  { id: 'next-step', text: '다음 작업을 우선순위와 검증 방법으로 정리해줘.', intent: 'next_step' },
];

export function fallbackFollowups() {
  return FALLBACK.map((item) => ({ ...item }));
}

export async function suggestFollowups({
  client,
  model,
  userPrompt,
  assistantAnswer,
  locale = 'ko',
  signal = null,
} = {}) {
  const requestId = crypto.randomUUID();
  try {
    const language = locale === 'en' ? 'English' : 'Korean';
    const result = await chatWithTools({
      client,
      model,
      messages: [
        {
          role: 'system',
          content: `You generate exactly three concise follow-up prompts for a coding assistant conversation. Write in ${language}. Identify one unverified assumption, one missing consideration, and one next action. Do not answer the conversation and never expose secrets. Return JSON only: {"suggestions":[{"id":"verify","text":"...","intent":"verify"},{"id":"gap","text":"...","intent":"gap"},{"id":"next-step","text":"...","intent":"next_step"}]}. Each text must be 12 to 160 characters.`,
        },
        {
          role: 'user',
          content: `[User request]\n${redact(tail(userPrompt, 4000))}\n\n[Completed assistant answer]\n${redact(tail(assistantAnswer, 8000))}`,
        },
      ],
      tools: [],
      temperature: 0.4,
      signal,
    });
    const suggestions = normalize(parseSuggestions(result.content || ''));
    if (suggestions.length !== 3) return { source: 'fallback', suggestions: fallbackFollowups(), requestId };
    return { source: 'ai', suggestions, requestId };
  } catch {
    return { source: 'fallback', suggestions: fallbackFollowups(), requestId };
  }
}

export function parseSuggestions(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  } catch {
    return [];
  }
}

function normalize(items) {
  const seen = new Set();
  return items.flatMap((item) => {
    const text = String(item?.text || '').split(/\s+/).join(' ').trim();
    const count = [...text].length;
    if (count < 12 || count > 160) return [];
    const key = text.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    const intent = ['verify', 'gap', 'next_step'].includes(item.intent) ? item.intent : 'next_step';
    return [{ id: String(item.id || intent), text, intent }];
  }).slice(0, 3);
}

function tail(value, max) {
  const chars = [...String(value || '')];
  return chars.length <= max ? chars.join('') : chars.slice(-max).join('');
}

function redact(text) {
  let next = String(text || '');
  for (const marker of ['sk-', 'Bearer ', 'Authorization:', '-----BEGIN']) {
    let start = next.indexOf(marker);
    while (start >= 0) {
      const end = next.indexOf('\n', start);
      next = `${next.slice(0, start)}[REDACTED]${end < 0 ? '' : next.slice(end)}`;
      start = next.indexOf(marker, start + 10);
    }
  }
  return next;
}
