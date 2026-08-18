/** Default provider attempts after the first try (so maxRetries=5 ⇒ up to 6 total requests). */
export const DEFAULT_PROVIDER_MAX_RETRIES = 5;

export function classifyProviderError(error) {
  if (error?.code === 'stream_idle_timeout') {
    return { category: 'timeout', retryable: false, status: 408 };
  }
  if (error?.name === 'AbortError' || /aborted|abort/i.test(String(error?.message || error))) {
    return { category: 'aborted', retryable: false };
  }
  const status = Number(
    error?.status
    || error?.statusCode
    || error?.response?.status
    || error?.error?.status
    || 0,
  );
  if (status === 401 || status === 403) return { category: 'auth', retryable: false, status };
  if (status === 400 || status === 404 || status === 422) return { category: 'invalid_request', retryable: false, status };
  if (status === 408) {
    return { category: 'timeout', retryable: true, status, retryAfterMs: retryAfter(error) };
  }
  if (status === 429) {
    return { category: 'rate_limit', retryable: true, status, retryAfterMs: retryAfter(error) };
  }
  // 529 = overloaded (Anthropic-style); 5xx = server faults
  if (status === 529 || (status >= 500 && status <= 599)) {
    return { category: 'server', retryable: true, status, retryAfterMs: retryAfter(error) };
  }
  const message = String(error?.message || error?.error?.message || error || '');
  const code = String(error?.code || error?.cause?.code || '');
  if (
    /timeout|timed out|econnreset|econnrefused|eai_again|enotfound|enetunreach|ehostunreach|epipe|network|socket|temporar|fetch failed|connection|overloaded|unavailable|bad gateway|gateway timeout/i.test(`${message} ${code}`)
  ) {
    return { category: 'network', retryable: true, status };
  }
  // OpenAI SDK connection/API errors often use these names without a stable status.
  if (/APIConnectionError|APIUserAbortError|InternalServerError|RateLimitError|APIError/i.test(String(error?.name || ''))) {
    if (/Abort|UserAbort/i.test(String(error?.name || ''))) return { category: 'aborted', retryable: false, status };
    if (/RateLimit/i.test(String(error?.name || ''))) {
      return { category: 'rate_limit', retryable: true, status: status || 429, retryAfterMs: retryAfter(error) };
    }
    return { category: 'server', retryable: true, status };
  }
  return { category: 'unknown', retryable: false, status };
}

export function isRetryableProviderError(error) {
  return classifyProviderError(error).retryable;
}

/** Exponential backoff with light jitter. attempt is 0-based (first retry = 0). */
export function providerRetryDelayMs(attempt, { retryAfterMs = 0 } = {}) {
  if (retryAfterMs > 0) return Math.min(Number(retryAfterMs) || 0, 30_000);
  const base = Math.min(20_000, 800 * (2 ** Math.max(0, attempt)));
  const jitter = Math.floor(Math.random() * 400);
  return base + jitter;
}

function retryAfter(error) {
  const headers = error?.headers;
  const value = headers?.['retry-after']
    || headers?.['Retry-After']
    || (typeof headers?.get === 'function' ? headers.get('retry-after') : null);
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 30_000) : 0;
}
