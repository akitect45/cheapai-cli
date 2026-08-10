export function classifyProviderError(error) {
  if (error?.name === 'AbortError' || /aborted|abort/i.test(String(error?.message || error))) {
    return { category: 'aborted', retryable: false };
  }
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  if (status === 401 || status === 403) return { category: 'auth', retryable: false, status };
  if (status === 400 || status === 404 || status === 422) return { category: 'invalid_request', retryable: false, status };
  if (status === 429) return { category: 'rate_limit', retryable: true, status, retryAfterMs: retryAfter(error) };
  if (status >= 500 && status <= 599) return { category: 'server', retryable: true, status };
  if (/timeout|timed out|econnreset|eai_again|enotfound|network|socket|temporar/i.test(String(error?.message || error))) {
    return { category: 'network', retryable: true, status };
  }
  return { category: 'unknown', retryable: false, status };
}

export function isRetryableProviderError(error) {
  return classifyProviderError(error).retryable;
}

function retryAfter(error) {
  const value = error?.headers?.['retry-after'] || error?.headers?.get?.('retry-after');
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 30_000) : 0;
}
