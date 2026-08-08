const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function normalizeUsage(usage = {}) {
  const inputTokens = number(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = number(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = number(usage.total_tokens) || inputTokens + outputTokens;
  const credits = number(usage.cost_credits ?? usage.cost_krw);
  const usd = number(usage.cost_usd ?? usage.cost);
  return { inputTokens, outputTokens, totalTokens, credits, usd };
}

export function mergeSessionUsage(previous = {}, usage = {}) {
  const current = normalizeUsage(usage);
  return {
    requests: number(previous.requests) + 1,
    inputTokens: number(previous.inputTokens) + current.inputTokens,
    outputTokens: number(previous.outputTokens) + current.outputTokens,
    totalTokens: number(previous.totalTokens) + current.totalTokens,
    credits: round2(number(previous.credits) + current.credits),
    usd: round6(number(previous.usd) + current.usd),
    lastInputTokens: current.inputTokens,
    lastOutputTokens: current.outputTokens,
    lastTotalTokens: current.totalTokens,
    lastUpdatedAt: new Date().toISOString(),
  };
}

export function estimateTextTokens(value) {
  const text = String(value ?? '');
  if (!text) return 0;
  return Math.ceil([...text].length / 4);
}

export function estimateMessagesTokens(messages = []) {
  let chars = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    chars += String(message.role || '').length + estimateTextTokens(message.content) * 4 + 12;
    for (const call of message.tool_calls || []) {
      chars += String(call?.function?.name || '').length;
      chars += String(call?.function?.arguments || '').length;
    }
  }
  return Math.ceil(chars / 4);
}

export function contextUsageLabel(messagesOrTokens, contextWindow) {
  const tokens = Array.isArray(messagesOrTokens)
    ? estimateMessagesTokens(messagesOrTokens)
    : number(messagesOrTokens);
  const window = number(contextWindow);
  if (!window) return `ctx ${formatTokens(tokens)}`;
  const percent = Math.min(999, Math.round((tokens / window) * 100));
  return `ctx ${formatTokens(tokens)} / ${formatTokens(window)} (${percent}%)`;
}

export function accountBalance(accountUsage) {
  return accountUsage?.balance ?? accountUsage?.credits ?? null;
}

export function accountUsageRows(accountUsage = {}) {
  const key = accountUsage.key || {};
  const metrics = accountUsage.metrics || accountUsage.usage || {};
  const remaining = key.creditsRemaining == null ? 'unlimited key' : formatCredits(key.creditsRemaining);
  return [
    ['balance', formatWon(accountBalance(accountUsage))],
    ['today', formatWon(accountUsage.spentToday ?? accountUsage.spent)],
    ['this month', formatWon(accountUsage.spentMonth)],
    ['12h requests', formatCredits(metrics.requests)],
    ['12h tokens', formatTokens(metrics.tokens)],
    ['12h spent', formatWon(metrics.spent)],
    ['key', key.name || accountUsage.username || '—'],
    ['key used', formatCredits(key.creditsUsed)],
    ['key remaining', remaining],
  ];
}

export function sessionUsageRows(sessionUsage = {}, messages = [], contextWindow = null) {
  return [
    ['requests', formatCredits(sessionUsage.requests)],
    ['input tokens', formatTokens(sessionUsage.inputTokens)],
    ['output tokens', formatTokens(sessionUsage.outputTokens)],
    ['total tokens', formatTokens(sessionUsage.totalTokens)],
    ['billed', formatWon(sessionUsage.credits)],
    ['context', contextUsageLabel(messages, contextWindow)],
  ];
}

export function formatCredits(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(Number(value));
}

export function formatWon(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `₩${formatCredits(value)}`;
}

export function formatTokens(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  if (n >= 1_000_000) return `${trimNumber(n / 1_000_000)}m`;
  if (n >= 1_000) return `${trimNumber(n / 1_000)}k`;
  return formatCredits(n);
}

export function formatCompactCredits(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  if (Math.abs(n) >= 1_000_000) return `${trimNumber(n / 1_000_000)}m`;
  if (Math.abs(n) >= 1_000) return `${trimNumber(n / 1_000)}k`;
  return formatCredits(n);
}

function trimNumber(value) {
  return Number(value.toFixed(1)).toString();
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
