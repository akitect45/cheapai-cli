function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

export function detectLineEnding(text) {
  return String(text || '').includes('\r\n') ? '\r\n' : '\n';
}

function collapseWhitespace(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ');
}

function adaptNewString(value, lineEnding) {
  const normalized = String(value ?? '').replace(/\r\n/g, '\n');
  return lineEnding === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

function locateNeedle(text, oldString) {
  if (typeof oldString !== 'string' || !oldString) return null;
  if (text.includes(oldString)) {
    return {
      needle: oldString,
      count: countOccurrences(text, oldString),
      normalized: false,
      lineEnding: detectLineEnding(text),
    };
  }
  for (const variant of unique([
    oldString.replace(/\r\n/g, '\n'),
    oldString.replace(/\n/g, '\r\n'),
  ])) {
    if (variant !== oldString && text.includes(variant)) {
      return {
        needle: variant,
        count: countOccurrences(text, variant),
        normalized: true,
        lineEnding: detectLineEnding(text),
      };
    }
  }
  return null;
}

function firstMeaningfulLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length >= 6) || '';
}

function similarEnough(line, target) {
  if (!line || !target) return false;
  if (line.includes(target) || target.includes(line.slice(0, 48))) return true;
  const left = collapseWhitespace(line);
  const right = collapseWhitespace(target);
  if (left.includes(right) || right.includes(left.slice(0, 48))) return true;
  const compactLine = line.replace(/\s+/g, '');
  const compactTarget = target.replace(/\s+/g, '');
  const sample = compactTarget.slice(0, 24);
  if (sample.length >= 12 && compactLine.includes(sample)) return true;
  if (
    compactLine.length >= 8
    && compactLine.length <= 80
    && Math.abs(compactLine.length - compactTarget.length) <= 4
  ) {
    return levenshtein(compactLine.slice(0, 64), compactTarget.slice(0, 64)) <= 3;
  }
  return false;
}

function levenshtein(left, right) {
  const rows = Array.from({ length: left.length + 1 }, (_, i) => {
    const row = new Array(right.length + 1);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= right.length; j++) rows[0][j] = j;
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
    }
  }
  return rows[left.length][right.length];
}

export function findSimilarLines(text, oldString, limit = 4) {
  const target = firstMeaningfulLine(oldString);
  if (!target) return [];
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (let index = 0; index < lines.length; index++) {
    if (!similarEnough(lines[index].trim(), target)) continue;
    out.push({ line: index + 1, text: lines[index].slice(0, 200) });
    if (out.length >= limit) break;
  }
  return out;
}

export function diagnoseEditMiss(text, oldString) {
  const hints = [];
  const fileHasCrlf = String(text || '').includes('\r\n');
  const needleHasCrlf = String(oldString || '').includes('\r\n');
  const fileLf = String(text || '').replace(/\r\n/g, '\n');
  const needleLf = String(oldString || '').replace(/\r\n/g, '\n');
  if (fileHasCrlf && !needleHasCrlf && fileLf.includes(needleLf)) {
    hints.push('File uses CRLF. Re-read the file and copy old_string exactly.');
  } else if (!fileHasCrlf && needleHasCrlf && fileLf.includes(needleLf)) {
    hints.push('File uses LF. Remove \\r from old_string.');
  } else if (collapseWhitespace(fileLf).includes(collapseWhitespace(needleLf))) {
    hints.push('A whitespace-normalized match exists. Copy old_string from read_file without the "N|" line prefix.');
  }
  const similar = findSimilarLines(text, oldString);
  return {
    error: 'old_string not found in file',
    hint: hints.join(' '),
    similar,
  };
}

export function applyExactReplace(text, oldString, newString, replaceAll = false) {
  if (typeof oldString !== 'string' || !oldString) {
    return { ok: false, error: 'old_string is required and must be non-empty' };
  }
  const found = locateNeedle(text, oldString);
  if (!found) return { ok: false, ...diagnoseEditMiss(text, oldString) };
  if (!replaceAll && found.count > 1) {
    return {
      ok: false,
      error: `old_string matched ${found.count} times; set replace_all=true or make it unique`,
      occurrences: found.count,
    };
  }
  const nextNew = found.normalized ? adaptNewString(newString, found.lineEnding) : String(newString ?? '');
  const next = replaceAll
    ? text.split(found.needle).join(nextNew)
    : text.replace(found.needle, nextNew);
  return {
    ok: true,
    text: next,
    replacements: replaceAll ? found.count : 1,
    normalized: found.normalized,
  };
}

export function applyEdits(text, edits) {
  if (!Array.isArray(edits) || !edits.length) {
    return { ok: false, error: 'edits must be a non-empty array' };
  }
  let current = text;
  const applied = [];
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index] || {};
    const result = applyExactReplace(current, edit.old_string, edit.new_string, !!edit.replace_all);
    if (!result.ok) {
      return {
        ok: false,
        error: `edits[${index}]: ${result.error}`,
        hint: result.hint || '',
        similar: result.similar || [],
        occurrences: result.occurrences,
        failed_index: index,
      };
    }
    current = result.text;
    applied.push({ replacements: result.replacements, normalized: !!result.normalized });
  }
  return {
    ok: true,
    text: current,
    replacements: applied.reduce((sum, item) => sum + item.replacements, 0),
    edits: applied,
  };
}

export function normalizeEditList(args = {}) {
  if (Array.isArray(args.edits) && args.edits.length) {
    return args.edits.map((edit) => ({
      old_string: String(edit?.old_string ?? ''),
      new_string: String(edit?.new_string ?? ''),
      replace_all: !!edit?.replace_all,
    }));
  }
  if (args.old_string != null && args.new_string != null) {
    return [{
      old_string: String(args.old_string),
      new_string: String(args.new_string),
      replace_all: !!args.replace_all,
    }];
  }
  return null;
}
