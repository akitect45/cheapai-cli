import {
  classifyProviderError,
  isRetryableProviderError,
  providerRetryDelayMs,
  DEFAULT_PROVIDER_MAX_RETRIES,
} from './errors.js';
import { buildResponsesCreateBody } from './responses-format.js';
import { streamResponsesTurn } from './responses-ws.js';

const providers = new Map();

export function registerProvider(provider) {
  if (!provider?.id || typeof provider.stream !== 'function') throw new Error('Invalid provider contract.');
  if (providers.has(provider.id)) throw new Error(`Provider already registered: ${provider.id}`);
  providers.set(provider.id, provider);
  return provider;
}

export function getProvider(id = 'openai-compatible') {
  const provider = providers.get(id);
  if (!provider) {
    const error = new Error(`Unknown provider: ${id}`);
    error.code = 'unknown_provider';
    throw error;
  }
  return provider;
}

export function listProviders() {
  return [...providers.values()];
}

export function createOpenAICompatibleProvider() {
  return {
    id: 'openai-compatible',
    async stream({
      client,
      model,
      messages,
      tools,
      temperature = 0.2,
      reasoningEffort = null,
      signal = null,
      onDelta,
      onThinking,
      onRetry = null,
      maxRetries = DEFAULT_PROVIDER_MAX_RETRIES,
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
      if (reasoningEffort && reasoningEffort !== 'off' && reasoningEffort !== 'none') {
        body.reasoning_effort = reasoningEffort;
        body.extra_body = { reasoning_effort: reasoningEffort };
      }

      let reasoningFallback = false;
      const retryBudget = Math.max(0, Number(maxRetries) || 0);
      for (let attempt = 0; ; attempt++) {
        try {
          return await consumeStream({
            client,
            body,
            signal,
            onDelta,
            onThinking,
          });
        } catch (error) {
          // Visible assistant text or tool-call fragments cannot be safely replayed
          // without duplicating UI/session output. Thinking-only prefixes remain retryable.
          if (error.partialOutput) throw error;
          if (!reasoningFallback && hasReasoningFields(body) && /reasoning|effort|unknown|unrecognized/i.test(String(error?.message || error))) {
            delete body.reasoning_effort;
            delete body.extra_body;
            reasoningFallback = true;
            continue;
          }
          if (attempt >= retryBudget || !isRetryableProviderError(error)) throw error;
          const classification = classifyProviderError(error);
          const waitMs = providerRetryDelayMs(attempt, { retryAfterMs: classification.retryAfterMs });
          onRetry?.({
            attempt: attempt + 1,
            maxRetries: retryBudget,
            waitMs,
            classification,
            error,
          });
          if (waitMs > 0) await delay(waitMs, signal);
        }
      }
    },
    async complete({ client, model, messages, temperature = 0.1, maxTokens = null, signal = null }) {
      const body = { model, messages, temperature, stream: false };
      if (maxTokens) body.max_tokens = maxTokens;
      return client.chat.completions.create(body, signal ? { signal } : undefined);
    },
    async models({ client }) {
      const response = await client.models.list();
      return (response.data || []).map(normalizeModelMetadata);
    },
    auth({ apiKey, baseURL } = {}) {
      return { scheme: 'bearer', configured: Boolean(apiKey), baseURL: baseURL || null };
    },
    classifyError: classifyProviderError,
    normalizeUsage(usage) {
      return usage || null;
    },
  };
}

export function createResponsesWsProvider() {
  return {
    id: 'openai-responses-ws',
    async stream({
      client,
      model,
      messages,
      tools,
      temperature = 0.2,
      reasoningEffort = null,
      signal = null,
      onDelta,
      onThinking,
      onRetry = null,
      maxRetries = DEFAULT_PROVIDER_MAX_RETRIES,
      baseURL,
      apiKey,
    }) {
      const body = buildResponsesCreateBody({ model, messages, tools, temperature, reasoningEffort });
      let reasoningFallback = false;
      const retryBudget = Math.max(0, Number(maxRetries) || 0);
      for (let attempt = 0; ; attempt++) {
        try {
          return await streamResponsesTurn({
            baseURL: baseURL || client?.baseURL,
            apiKey: apiKey || client?.apiKey,
            body,
            signal,
            onDelta,
            onThinking,
          });
        } catch (error) {
          if (error.partialOutput) throw error;
          if (!reasoningFallback && hasReasoningFields(body) && /reasoning|effort|unknown|unrecognized/i.test(String(error?.message || error))) {
            delete body.reasoning;
            delete body.reasoning_effort;
            reasoningFallback = true;
            continue;
          }
          if (attempt >= retryBudget || !isRetryableProviderError(error)) throw error;
          const classification = classifyProviderError(error);
          const waitMs = providerRetryDelayMs(attempt, { retryAfterMs: classification.retryAfterMs });
          onRetry?.({
            attempt: attempt + 1,
            maxRetries: retryBudget,
            waitMs,
            classification,
            error,
          });
          if (waitMs > 0) await delay(waitMs, signal);
        }
      }
    },
    async complete(options) {
      return getProvider('openai-compatible').complete(options);
    },
    async models(options) {
      return getProvider('openai-compatible').models(options);
    },
    auth({ apiKey, baseURL } = {}) {
      return { scheme: 'bearer', configured: Boolean(apiKey), baseURL: baseURL || null, wireApi: 'responses-ws' };
    },
    classifyError: classifyProviderError,
    normalizeUsage(usage) {
      return usage || null;
    },
  };
}

registerProvider(createOpenAICompatibleProvider());
registerProvider(createResponsesWsProvider());

export function normalizeModelMetadata(model = {}) {
  return {
    ...model,
    provider: model.provider || 'openai-compatible',
    id: String(model.id || ''),
    contextWindow: Number(model.contextWindow || model.context_window || model.max_tokens || 0) || null,
    maxTokens: Number(model.maxTokens || model.max_tokens || 0) || null,
    reasoning: Boolean(model.reasoning || model.supports_reasoning || model.reasoning_effort),
    inputModalities: model.inputModalities || model.input_modalities || ['text'],
    cost: model.cost || model.pricing || null,
  };
}

async function consumeStream({ client, body, signal, onDelta, onThinking }) {
  const stream = await client.chat.completions.create(body, signal ? { signal } : undefined);
  let content = '';
  const toolMap = new Map();
  let finish_reason = null;
  let usage = null;
  let thinking = '';

  try {
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
      const thought = delta.reasoning_content || delta.reasoning || delta.thinking
        || (typeof delta.reasoning_details === 'string' ? delta.reasoning_details : null);
      if (thought) {
        thinking += thought;
        onThinking?.(thought);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          if (!toolMap.has(index)) {
            toolMap.set(index, {
              id: tc.id || `call_${index}`,
              type: 'function',
              function: { name: '', arguments: '' },
            });
          }
          const current = toolMap.get(index);
          if (tc.id) current.id = tc.id;
          if (tc.function?.name) current.function.name += tc.function.name;
          if (tc.function?.arguments) current.function.arguments += tc.function.arguments;
        }
      }
    }
  } catch (error) {
    // Only assistant content / tool fragments make a stream non-replayable.
    // Reasoning-only partials are safe to discard and retry.
    error.partialOutput = Boolean(content || toolMap.size);
    throw error;
  }

  return {
    content,
    tool_calls: [...toolMap.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).filter((value) => value.function.name),
    finish_reason,
    usage,
    thinking,
  };
}

function hasReasoningFields(body) {
  return Boolean(body.reasoning_effort || body.reasoning || body.extra_body?.reasoning_effort);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
