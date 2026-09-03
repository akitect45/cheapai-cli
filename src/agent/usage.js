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

export function isPlanBilling(accountUsage = {}) {
  if (!accountUsage || typeof accountUsage !== 'object') return false;
  if (accountUsage.billingMode === 'usage' || accountUsage.unit === 'credits') return false;
  if (accountUsage.billingMode === 'plan' || accountUsage.unit === 'percent') return true;
  return Number.isFinite(Number(accountUsage.remainingPercent))
    || accountUsage.planTier != null
    || accountUsage.extraCredits != null
    || accountUsage.remainingOk != null;
}

export function formatPlanPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${Math.round(Number(value))}%`;
}

export function formatPeriodEnd(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function planTierLabel(tier) {
  const id = String(tier || '').trim();
  if (!id) return '—';
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Header chip: plan remaining %, plus extra credits if the wallet has a top-up. */
export function accountHeaderLabel(accountUsage) {
  if (!accountUsage) return null;
  if (isPlanBilling(accountUsage)) {
    const extra = Number(accountUsage.extraCredits);
    const hasExtra = Number.isFinite(extra) && extra > 0;
    const percent = Number(accountUsage.remainingPercent);
    const parts = [];
    if (Number.isFinite(percent)) parts.push(`${Math.round(percent)}% left`);
    if (hasExtra) parts.push(`extra ${formatCompactCredits(extra)}`);
    if (!parts.length) return accountUsage.remainingOk === false ? 'plan empty' : null;
    if (accountUsage.remainingOk === false && !hasExtra) return 'plan empty';
    return parts.join(' · ');
  }
  const extra = Number(accountUsage.extraCredits ?? accountBalance(accountUsage));
  if (Number.isFinite(extra) && extra > 0) return `extra ${formatCompactCredits(extra)}`;
  return accountUsage.remainingOk === false ? 'plan empty' : null;
}

export function accountUsageRows(accountUsage = {}) {
  const key = accountUsage.key || {};
  const metrics = accountUsage.metrics || accountUsage.usage || {};
  const remaining = key.creditsRemaining == null ? 'unlimited key' : formatCredits(key.creditsRemaining);
  if (isPlanBilling(accountUsage)) {
    const extra = Number(accountUsage.extraCredits);
    return [
      ['plan', planTierLabel(accountUsage.planTier)],
      ['period', accountUsage.period || 'week'],
      ['used', formatPlanPercent(accountUsage.usedPercent)],
      ['left', formatPlanPercent(accountUsage.remainingPercent)],
      ['resets', formatPeriodEnd(accountUsage.periodEnd)],
      ['extra credits', Number.isFinite(extra) ? formatCredits(extra) : '0'],
      ['can send', accountUsage.remainingOk === false ? 'no — top up extra credits' : 'yes'],
      ['12h requests', formatCredits(metrics.requests ?? metrics.requests_12h)],
      ['12h tokens', formatTokens(metrics.tokens ?? metrics.tokens_12h)],
      ['key', key.name || accountUsage.username || '—'],
      ['key used', formatCredits(key.creditsUsed)],
      ['key remaining', remaining],
    ];
  }
  const extra = Number(accountUsage.extraCredits ?? accountBalance(accountUsage));
  return [
    ['extra credits', Number.isFinite(extra) ? formatCredits(extra) : '—'],
    ['can send', accountUsage.remainingOk === false ? 'no — top up extra credits' : 'yes'],
    ['12h requests', formatCredits(metrics.requests ?? metrics.requests_12h)],
    ['12h tokens', formatTokens(metrics.tokens ?? metrics.tokens_12h)],
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
    ['context', contextUsageLabel(messages, contextWindow)],
  ];
}

export function planStatusRows(accountUsage) {
  if (!accountUsage) return [['plan', 'not loaded']];
  if (!isPlanBilling(accountUsage)) {
    return [['account', accountHeaderLabel(accountUsage) || '—']];
  }
  const extra = Number(accountUsage.extraCredits);
  return [
    ['plan', planTierLabel(accountUsage.planTier)],
    ['left', formatPlanPercent(accountUsage.remainingPercent)],
    ['resets', formatPeriodEnd(accountUsage.periodEnd)],
    ['extra credits', Number.isFinite(extra) ? formatCredits(extra) : '0'],
    ['can send', accountUsage.remainingOk === false ? 'no — top up extra credits' : 'yes'],
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
