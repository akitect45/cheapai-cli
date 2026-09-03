/**
 * Research harness contract: parse METRIC / ASI lines from captured output.
 *
 * The workload command exits 0 on success. It prints the primary metric as
 * `METRIC <name>=<value>` and optional `ASI <key>=<value>` learnings.
 * Noise and malformed lines are ignored. Prototype-polluting keys are dropped.
 */

export const HARNESS_FILENAME = 'autoresearch.sh';
export const DEFAULT_HARNESS_COMMAND = `bash ${HARNESS_FILENAME}`;
export const METRIC_LINE_PREFIX = 'METRIC';
export const ASI_LINE_PREFIX = 'ASI';

export const DENIED_KEY_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

const METRIC_LINE_RE = new RegExp(`^${METRIC_LINE_PREFIX}\\s+([\\w.µ-]+)=(\\S+)\\s*$`, 'gm');
const ASI_LINE_RE = new RegExp(`^${ASI_LINE_PREFIX}\\s+([\\w.-]+)=(.+)\\s*$`, 'gm');

export function parseMetricLines(output) {
  const metrics = new Map();
  let match = METRIC_LINE_RE.exec(output);
  while (match !== null) {
    const name = match[1] ?? '';
    if (!DENIED_KEY_NAMES.has(name)) {
      const value = Number(match[2]);
      if (Number.isFinite(value)) metrics.set(name, value);
    }
    match = METRIC_LINE_RE.exec(output);
  }
  return metrics;
}

export function parseAsiLines(output) {
  const asi = {};
  let match = ASI_LINE_RE.exec(output);
  while (match !== null) {
    const key = match[1] ?? '';
    if (!DENIED_KEY_NAMES.has(key)) asi[key] = parseAsiValue(match[2] ?? '');
    match = ASI_LINE_RE.exec(output);
  }
  return Object.keys(asi).length > 0 ? asi : null;
}

function parseAsiValue(raw) {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }
  if (value.startsWith('{') || value.startsWith('[') || value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function parseHarnessOutput(output, primaryMetricName) {
  const metricMap = parseMetricLines(String(output || ''));
  const metrics = {};
  for (const [name, value] of metricMap.entries()) metrics[name] = value;
  let primary = null;
  if (primaryMetricName !== undefined) {
    primary = metricMap.has(primaryMetricName) ? metricMap.get(primaryMetricName) : null;
  } else {
    const first = metricMap.entries().next();
    primary = first.done ? null : first.value[1];
  }
  return { metrics, primary, asi: parseAsiLines(String(output || '')) };
}

export function isBetter(current, best, direction) {
  return direction === 'lower' ? current < best : current > best;
}

export function inferMetricUnitFromName(name) {
  if (name.endsWith('µs') || name.endsWith('_µs')) return 'µs';
  if (name.endsWith('ms') || name.endsWith('_ms')) return 'ms';
  if (name.endsWith('_s') || name.endsWith('_sec') || name.endsWith('_secs')) return 's';
  if (name.endsWith('_kb') || name.endsWith('kb')) return 'kb';
  if (name.endsWith('_mb') || name.endsWith('mb')) return 'mb';
  return '';
}

export function sanitizeMetrics(value) {
  if (typeof value !== 'object' || value === null) return {};
  const out = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (DENIED_KEY_NAMES.has(key)) continue;
    if (typeof entryValue === 'number' && Number.isFinite(entryValue)) out[key] = entryValue;
  }
  return out;
}
