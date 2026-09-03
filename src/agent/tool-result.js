export const MAX_TOOL_RESULT_CHARS = 80_000;

export function serializeToolResult(result, maxChars = MAX_TOOL_RESULT_CHARS) {
  let raw;
  try {
    raw = JSON.stringify(result ?? {});
  } catch {
    return JSON.stringify({ error: 'Tool result could not be serialized.', code: 'serialize_error' });
  }
  if (raw.length <= maxChars) return raw;

  const compact = compactToolResult(result);
  let next = JSON.stringify({
    ...compact,
    truncated: true,
    original_chars: raw.length,
    hint: 'Result truncated. Narrow the path, use offset/limit, or lower max_matches/max_results.',
  });
  if (next.length <= maxChars) return next;
  return JSON.stringify({
    error: 'Tool result was too large and was dropped.',
    truncated: true,
    original_chars: raw.length,
    hint: 'Re-run with a narrower query.',
  });
}

function compactToolResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { value: String(result ?? '').slice(0, 4_000) };
  }
  const out = { ...result };
  if (typeof out.content === 'string') out.content = clip(out.content, 20_000);
  if (typeof out.stdout === 'string') out.stdout = clip(out.stdout, 12_000);
  if (typeof out.stderr === 'string') out.stderr = clip(out.stderr, 4_000);
  if (typeof out.text === 'string') out.text = clip(out.text, 20_000);
  if (Array.isArray(out.files)) out.files = out.files.slice(0, 80);
  if (Array.isArray(out.matches)) out.matches = out.matches.slice(0, 40);
  if (Array.isArray(out.entries)) out.entries = out.entries.slice(0, 80);
  delete out.diff;
  return out;
}

function clip(text, max) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}\n\n[truncated]` : value;
}
