import OpenAI from 'openai';
import { loadAuth, loadConfig, resolveApiKey, resolveBaseUrl, resolveModel, saveConfig } from '../config.js';

export function createClient(overrides = {}) {
  const auth = loadAuth();
  const cfg = loadConfig();
  const apiKey = overrides.apiKey || resolveApiKey(auth);
  if (!apiKey) {
    throw new Error(
      'API 키가 없습니다. `cheapai login` 또는 환경변수 CHEAPAI_API_KEY 를 설정하세요.',
    );
  }
  const baseURL = overrides.baseUrl || resolveBaseUrl(cfg, auth);
  return {
    client: new OpenAI({ apiKey, baseURL, defaultHeaders: { 'User-Agent': 'CheapAI-CLI/0.3' } }),
    model: resolveModel(overrides.model, cfg),
    baseURL,
    apiKey,
    cfg,
  };
}

/**
 * Stream chat completion with tools + optional reasoning effort.
 */
export async function chatWithTools({
  client,
  model,
  messages,
  tools,
  temperature = 0.2,
  reasoningEffort = null,
  onDelta,
  onThinking,
}) {
  const body = {
    model,
    messages,
    tools: tools?.length ? tools : undefined,
    tool_choice: tools?.length ? 'auto' : undefined,
    temperature,
    stream: true,
    stream_options: { include_usage: true },
  };

  // Common OpenAI / proxy fields for "thinking" / reasoning
  if (reasoningEffort && reasoningEffort !== 'off' && reasoningEffort !== 'none') {
    body.reasoning_effort = reasoningEffort; // o-series style
    // some gateways
    body.extra_body = {
      ...(body.extra_body || {}),
      reasoning_effort: reasoningEffort,
    };
  }

  let stream;
  try {
    stream = await client.chat.completions.create(body);
  } catch (err) {
    // Retry without reasoning fields if rejected
    if (reasoningEffort && /reasoning|effort|unknown|unrecognized/i.test(String(err.message))) {
      delete body.reasoning_effort;
      delete body.extra_body;
      stream = await client.chat.completions.create(body);
    } else {
      throw err;
    }
  }

  let content = '';
  /** @type {Map<number, { id: string, type: string, function: { name: string, arguments: string } }>} */
  const toolMap = new Map();
  let finish_reason = null;
  let usage = null;
  let thinking = '';

  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish_reason = choice.finish_reason;
    const delta = choice.delta || {};

    if (delta.content) {
      content += delta.content;
      onDelta?.(delta.content);
    }

    // various thinking/reasoning delta shapes
    const thought =
      delta.reasoning_content ||
      delta.reasoning ||
      delta.thinking ||
      (typeof delta.reasoning_details === 'string' ? delta.reasoning_details : null);
    if (thought) {
      thinking += thought;
      onThinking?.(thought);
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolMap.has(idx)) {
          toolMap.set(idx, {
            id: tc.id || `call_${idx}`,
            type: 'function',
            function: { name: '', arguments: '' },
          });
        }
        const acc = toolMap.get(idx);
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.function.name += tc.function.name;
        if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
      }
    }
  }

  const tool_calls = [...toolMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((v) => v.function.name);

  return { content, tool_calls, finish_reason, usage, thinking };
}

export async function listModels(client) {
  const res = await client.models.list();
  return res.data || [];
}

export async function modelInfo(client, model) {
  const models = await listModels(client);
  return models.find((item) => item.id === model) || null;
}

export async function fetchAccountUsage({ baseURL, apiKey } = {}) {
  const base = String(baseURL || resolveBaseUrl(loadConfig(), loadAuth())).replace(/\/$/, '');
  const key = apiKey || resolveApiKey();
  if (!key) throw new Error('API key required to check usage.');
  const res = await fetch(`${base}/usage`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${key}`,
      'User-Agent': 'CheapAI-CLI/0.3',
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || body?.error || `usage request failed (${res.status})`);
  return body;
}

export function persistModel(model) {
  const cfg = loadConfig();
  cfg.model = model;
  saveConfig(cfg);
}

export function persistEffort(effort) {
  const cfg = loadConfig();
  cfg.reasoningEffort = effort;
  saveConfig(cfg);
}
