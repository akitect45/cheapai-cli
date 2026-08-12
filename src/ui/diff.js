/**
 * Lightweight line-oriented diffs for tool results (OpenCode-style before/after).
 * Prefer showing the changed region rather than a full-file patch.
 */

/**
 * @param {string} beforeText
 * @param {string} afterText
 * @returns {{ type: 'ctx'|'add'|'del', text: string, oldLine?: number, newLine?: number }[]}
 */
export function computeDiffLines(beforeText, afterText) {
  const a = splitLines(beforeText);
  const b = splitLines(afterText);
  if (!a.length && !b.length) return [];

  // Peel common prefix / suffix — ideal for surgical edit_file hunks and local rewrites.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }

  const lines = [];
  const ctx = 2;
  const ctxFrom = Math.max(0, start - ctx);
  for (let i = ctxFrom; i < start; i += 1) {
    lines.push({ type: 'ctx', text: a[i], oldLine: i + 1, newLine: i + 1 });
  }
  for (let i = start; i <= endA; i += 1) {
    lines.push({ type: 'del', text: a[i], oldLine: i + 1 });
  }
  for (let i = start; i <= endB; i += 1) {
    lines.push({ type: 'add', text: b[i], newLine: i + 1 });
  }
  const ctxToA = Math.min(a.length - 1, endA + ctx);
  let newLineCursor = endB + 1;
  for (let i = endA + 1; i <= ctxToA; i += 1) {
    newLineCursor += 1;
    lines.push({ type: 'ctx', text: a[i], oldLine: i + 1, newLine: newLineCursor });
  }
  return lines;
}

export function countDiffStats(beforeText, afterText) {
  const lines = computeDiffLines(beforeText, afterText);
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.type === 'add') additions += 1;
    else if (line.type === 'del') deletions += 1;
  }
  return { additions, deletions };
}

/**
 * Build a compact, model-safe diff payload for tool results.
 * @param {string} beforeText
 * @param {string} afterText
 * @param {{ maxLines?: number }} [opts]
 */
export function buildDiffPayload(beforeText, afterText, { maxLines = 60 } = {}) {
  const before = String(beforeText ?? '');
  const after = String(afterText ?? '');
  const stats = countDiffStats(before, after);
  const lines = computeDiffLines(before, after);
  const limited = lines.slice(0, Math.max(4, maxLines));
  return {
    additions: stats.additions,
    deletions: stats.deletions,
    lines: limited.map((line) => ({
      type: line.type,
      text: line.text.length > 240 ? `${line.text.slice(0, 239)}…` : line.text,
    })),
    truncated: limited.length < lines.length || before.length > 40_000 || after.length > 40_000,
  };
}

/**
 * Format ANSI-colored unified diff rows for the TUI.
 * @param {{ type: string, text: string }[]} lines
 * @param {(s: string) => string} paintAdd
 * @param {(s: string) => string} paintDel
 * @param {(s: string) => string} paintCtx
 * @param {number} maxWidth
 */
export function paintDiffLines(lines, { paintAdd, paintDel, paintCtx, maxWidth = 80, maxLines = 48 } = {}) {
  const out = [];
  const width = Math.max(12, maxWidth);
  const rows = (lines || []).slice(0, maxLines);
  for (const line of rows) {
    const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
    const body = clipPlain(`${marker} ${line.text ?? ''}`, width);
    if (line.type === 'add') out.push(paintAdd(body));
    else if (line.type === 'del') out.push(paintDel(body));
    else out.push(paintCtx(body));
  }
  if ((lines || []).length > rows.length) {
    out.push(paintCtx(`  … ${(lines.length - rows.length)} more lines`));
  }
  return out;
}

export function formatDiffStats({ additions = 0, deletions = 0 } = {}) {
  if (!additions && !deletions) return '';
  const parts = [];
  if (additions) parts.push(`+${additions}`);
  if (deletions) parts.push(`-${deletions}`);
  return parts.join(' ');
}

function splitLines(value) {
  if (value == null) return [];
  const text = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (text === '') return [];
  return text.split('\n');
}

function clipPlain(text, maxWidth) {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return '…';
  return `${text.slice(0, maxWidth - 1)}…`;
}
