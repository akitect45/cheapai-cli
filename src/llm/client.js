import OpenAI from 'openai';
import { loadAuth, loadConfig, resolveApiKey, resolveBaseUrl, resolveModel, saveConfig } from '../config.js';
import { getProvider } from './providers.js';
import { DEFAULT_PROVIDER_MAX_RETRIES } from './errors.js';

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
    client: new OpenAI({ apiKey, baseURL, maxRetries: 0, defaultHeaders: { 'User-Agent': 'CheapAI-CLI/0.3' } }),
    model: resolveModel(overrides.model, cfg),
    baseURL,
    apiKey,
    cfg,
    providerId: 'openai-compatible',
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
  onRetry = null,
  signal = null,
  maxRetries = DEFAULT_PROVIDER_MAX_RETRIES,
  idleTimeoutMs,
}) {
  return getProvider('openai-compatible').stream({
    client,
    model,
    messages,
    tools,
    temperature,
    reasoningEffort,
    signal,
    onDelta,
    onThinking,
    onRetry,
    maxRetries,
    idleTimeoutMs,
  });
}

export async function listModels(client, { providerId = 'openai-compatible' } = {}) {
  return getProvider(providerId).models({ client });
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
