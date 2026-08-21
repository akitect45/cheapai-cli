import { t } from './theme.js';

const graphemeSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;
const extendedPictographic = /\p{Extended_Pictographic}/u;

export function termWidth() {
  return Math.max(20, process.stdout.columns || 80);
}

export function clearScreen() {
  // clear + home (works in Windows Terminal / modern PS)
  if (!process.stdout.isTTY || process.env.TERM === 'dumb') return;
  process.stdout.write('\x1b[2J\x1b[H');
}

export function hr(char = '─') {
  const w = termWidth();
  return t.border(char.repeat(w));
}

/**
 * Full-width rule with a centered label, e.g.
 * ──────── compacting now... ────────
 */
export function statusBanner(label, width = termWidth(), paint = (s) => t.dim(s)) {
  const text = ` ${String(label || '').trim()} `;
  const w = Math.max(8, Number(width) || termWidth());
  const textWidth = displayWidth(text);
  if (textWidth >= w) return paint(`${'─'.repeat(Math.max(1, w - 1))}…`);
  const left = Math.floor((w - textWidth) / 2);
  const right = Math.max(0, w - left - textWidth);
  return paint(`${'─'.repeat(left)}${text}${'─'.repeat(right)}`);
}

export function box(lines, { title, width } = {}) {
  const w = width || Math.max(18, termWidth() - 2);
  const top = title
    ? `╭─ ${title} ${'─'.repeat(Math.max(0, w - title.length - 4))}╮`
    : `╭${'─'.repeat(w)}╮`;
  const bot = `╰${'─'.repeat(w)}╯`;
  const body = lines.map((line) => {
    const plain = stripAnsi(String(line));
    const pad = Math.max(0, w - 2 - plain.length);
    return `│ ${line}${' '.repeat(pad)}│`;
  });
  return [t.border(top), ...body.map((l) => t.border(l.slice(0, 1)) + l.slice(1, -1) + t.border(l.slice(-1))), t.border(bot)].join(
    '\n',
  );
}

/** Simpler box without broken ANSI padding */
export function panel(title, bodyLines) {
  const w = Math.max(18, termWidth() - 2);
  const out = [];
  out.push(t.border(`╭${'─'.repeat(w - 2)}╮`));
  if (title) {
    const titleText = ` ${clip(stripAnsi(title), w - 4)} `;
    out.push(t.border('│') + ' ' + t.bold(t.accent(titleText)) + ' '.repeat(Math.max(0, w - 3 - displayWidth(titleText))) + t.border('│'));
    out.push(t.border(`├${'─'.repeat(w - 2)}┤`));
  }
  for (const line of bodyLines) {
    for (const wrapped of wrapAnsi(String(line), w - 4)) {
      const pad = Math.max(0, w - 2 - displayWidth(wrapped) - 2);
      out.push(t.border('│') + ' ' + wrapped + ' '.repeat(pad) + ' ' + t.border('│'));
    }
  }
  out.push(t.border(`╰${'─'.repeat(w - 2)}╯`));
  return out.join('\n');
}

export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

export function displayWidth(value) {
  const text = stripAnsi(value).replace(/\r/g, '');
  if (graphemeSegmenter) {
    let width = 0;
    for (const { segment } of graphemeSegmenter.segment(text)) width += graphemeWidth(segment);
    return width;
  }
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === 0x200d || (code >= 0x300 && code <= 0x36f)) continue;
    width += isWideCodePoint(code) ? 2 : 1;
  }
  return width;
}

/** Iterate grapheme clusters (falls back to code points). */
export function iterateGraphemes(value) {
  const text = String(value || '');
  if (graphemeSegmenter) {
    return [...graphemeSegmenter.segment(text)].map(({ segment }) => segment);
  }
  return [...text];
}

/**
 * Slice plain text by display-cell columns [startCell, endCell).
 * Wide glyphs are included wholly when any of their cells overlap the range.
 */
export function sliceByCells(value, startCell, endCell) {
  const plain = stripAnsi(String(value || ''));
  const start = Math.max(0, Number(startCell) || 0);
  const end = endCell == null || !Number.isFinite(Number(endCell))
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Number(endCell));
  if (end <= start) return '';
  let cells = 0;
  let out = '';
  for (const segment of iterateGraphemes(plain)) {
    const w = displayWidth(segment);
    const next = cells + w;
    if (next > start && cells < end) out += segment;
    cells = next;
    if (cells >= end) break;
  }
  return out;
}

/**
 * Paint inverse video on display-cell columns [startCell, endCell) of a (possibly ANSI-styled) line.
 * Uses SGR 7/27 so surrounding styles are preserved better than a full reset.
 */
export function paintInverseCells(line, startCell, endCell) {
  const source = String(line || '');
  const start = Math.max(0, Number(startCell) || 0);
  const end = endCell == null || !Number.isFinite(Number(endCell))
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Number(endCell));
  if (!(end > start) || !source) return source;

  const tokens = source.match(/\x1b\[[0-?]*[ -/]*[@-~]|[^\x1b]+/g) || [];
  let cells = 0;
  let out = '';
  let inverseOn = false;

  const setInverse = (on) => {
    if (on === inverseOn) return;
    out += on ? '\x1b[7m' : '\x1b[27m';
    inverseOn = on;
  };

  for (const token of tokens) {
    if (token.startsWith('\x1b[')) {
      out += token;
      // After a full reset, re-assert inverse if we are still inside the range.
      if (token === '\x1b[0m' || token === '\x1b[m') {
        if (inverseOn) out += '\x1b[7m';
      }
      continue;
    }
    for (const segment of iterateGraphemes(token)) {
      const w = displayWidth(segment);
      const overlaps = cells + w > start && cells < end;
      setInverse(overlaps);
      out += segment;
      cells += w;
    }
  }
  setInverse(false);
  return out;
}

function graphemeWidth(segment) {
  const codePoints = [...segment].filter((char) => {
    const code = char.codePointAt(0);
    return code !== 0x200d && code !== 0xfe0e && code !== 0xfe0f && !(code >= 0x1f3fb && code <= 0x1f3ff);
  });
  if (!codePoints.length) return 0;
  if (segment.includes('\u200d') && extendedPictographic.test(segment) || codePoints.length > 1 && codePoints.every((char) => {
    const code = char.codePointAt(0);
    return code >= 0x1f1e6 && code <= 0x1f1ff;
  }) || segment.includes('\ufe0f')) return 2;
  if (segment.includes('\u200d')) {
    return codePoints.reduce((width, char) => {
      const code = char.codePointAt(0);
      if (code >= 0x300 && code <= 0x36f) return width;
      return width + (isWideCodePoint(code) ? 2 : 1);
    }, 0);
  }
  const code = codePoints[0].codePointAt(0);
  if (isWideCodePoint(code)) return 2;
  if (code >= 0x300 && code <= 0x36f) return 0;
  return 1;
}

export function sanitizeTerminalText(value) {
  return stripAnsi(value)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Terminal tab / window title for the chat workspace.
 * Busy states blink ● / ○ via the frame counter.
 */
export function formatTabTitle({ busy = false, thinking = false, sessionLabel = '', frame = 0 } = {}) {
  const session = String(sessionLabel || 'session').replace(/\s+/g, ' ').trim().slice(0, 48) || 'session';
  if (!busy) return `cheapai · ${session}`;
  const pulse = Math.floor(Number(frame) / 4) % 2 === 0 ? '●' : '○';
  const phase = thinking ? 'thinking...' : 'working...';
  return `${pulse} ${phase} ${session}`;
}

/** OSC 0 title — works in Windows Terminal, modern PowerShell, iTerm, etc. */
export function writeTerminalTitle(title) {
  if (!process.stdout.isTTY || process.env.TERM === 'dumb') return;
  const safe = String(title ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  process.stdout.write(`\x1b]0;${safe}\x07`);
  try {
    process.title = safe || 'cheapai';
  } catch {
    /* ignore */
  }
}

/**
 * Lightweight markdown → terminal text for chat messages.
 * Renders **bold** (and protected `code` / ``` fences). Markers are removed
 * even when color is disabled so chat never shows raw ** markers.
 */
export function formatMarkdown(text) {
  const source = String(text ?? '');
  if (!source) return '';
  const color = process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  const boldOpen = color ? '\x1b[1m' : '';
  const boldClose = color ? '\x1b[22m' : '';
  const codeOpen = color ? '\x1b[2m' : '';
  const codeClose = color ? '\x1b[22m' : '';

  let out = '';
  let index = 0;
  let inFence = false;

  while (index < source.length) {
    if (source.startsWith('```', index)) {
      inFence = !inFence;
      out += '```';
      index += 3;
      continue;
    }
    if (inFence) {
      out += source[index++];
      continue;
    }

    if (source[index] === '`') {
      const end = source.indexOf('`', index + 1);
      if (end !== -1 && !source.slice(index + 1, end).includes('\n')) {
        const inner = source.slice(index + 1, end);
        out += `\`${codeOpen}${inner}${codeClose}\``;
        index = end + 1;
        continue;
      }
    }

    if (source.startsWith('**', index)) {
      const end = source.indexOf('**', index + 2);
      if (end !== -1) {
        const inner = source.slice(index + 2, end);
        // Single-line emphasis only — avoids eating list bullets / unfinished stream spans.
        if (inner.length > 0 && !inner.includes('\n') && !inner.includes('`')) {
          out += `${boldOpen}${inner}${boldClose}`;
          index = end + 2;
          continue;
        }
      }
    }

    out += source[index++];
  }

  return out;
}

export function wrapAnsi(value, width) {
  const max = Math.max(1, width || termWidth() - 4);
  const lines = [];
  for (const source of String(value).split('\n')) {
    if (!source) {
      lines.push('');
      continue;
    }
    let line = '';
    let cells = 0;
    let active = '';
    const tokens = source.match(/\x1b\[[0-?]*[ -/]*[@-~]|[\s\S]/g) || [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      const isAnsi = token.startsWith('\x1b[');
      if (isAnsi) {
        active = token === t.reset ? '' : active + token;
        line += token;
        continue;
      }

      let plain = token;
      while (index + 1 < tokens.length && !tokens[index + 1].startsWith('\x1b[')) {
        plain += tokens[++index];
      }
      const segments = graphemeSegmenter
        ? [...graphemeSegmenter.segment(plain)].map(({ segment }) => segment)
        : [...plain];
      for (const segment of segments) {
        const next = displayWidth(segment);
        if (cells && cells + next > max) {
          lines.push(active ? line + t.reset : line);
          line = active;
          cells = 0;
        }
        line += segment;
        cells += next;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function bannerLogo() {
  if (termWidth() < 48) return t.bold(t.accent('  cheap')) + t.bold(t.gray('ai'));
  return [
    `  ${t.accent('█▀▀ █ █ █▀▀ ▄▀█ █▀█')}${t.gray('  ▄▀█ █')}`,
    `  ${t.accent('█▄▄ █▀█ ██▄ █▀█ █▀▀')}${t.gray('  █▀█ █')}`,
  ].join('\n');
}

export function statusBar({ model, mode, effort, cwd, user, session }) {
  const width = Math.max(18, termWidth() - 2);
  const policy = width < 32 ? compactPermissionLabel(mode) : permissionLabel(mode);
  const project = clip(shortPath(cwd || process.cwd()), width < 76 ? 26 : 44);
  const sessionLabel = session ? `s:${session.slice(0, 6)}` : '';
  if (width < 54) {
    const projectName = project.split('/').filter(Boolean).at(-1) || project;
    const sessionMeta = width >= 40 && sessionLabel ? `  ${t.dim(sessionLabel)}` : '';
    const projectWidth = Math.max(8, width - 14 - displayWidth(stripAnsi(sessionMeta)));
    const modelWidth = Math.max(6, width - displayWidth(stripAnsi(policy)) - 2);
    return [
      `${t.bold(t.accent('cheapai'))}  ${t.white(clip(projectName, projectWidth))}${sessionMeta}`,
      `${t.cyan(clip(model || '—', modelWidth))}  ${policy}`,
      effort && effort !== 'off' ? t.magenta(`effort:${effort}`) : t.dim('effort:off'),
    ].join('\n');
  }
  const primary = [t.bold(t.accent('cheapai')), t.dim('/'), t.white(project), sessionLabel ? t.dim(sessionLabel) : ''].filter(Boolean);
  const meta = [t.cyan(model || '—'), policy, effort && effort !== 'off' ? t.magenta(`effort:${effort}`) : t.dim('effort:off')].filter(Boolean);
  const first = `  ${primary.map(stripAnsi).join('  ')}`;
  if (width < 62 || displayWidth(first) + displayWidth(meta.map(stripAnsi).join('  ')) + 8 > width) {
    return [primary.join('  '), meta.join('  ')].join('\n');
  }
  return primary.concat(meta).join('  ');
}

export function shortPath(p) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  let s = p;
  if (home && s.startsWith(home)) s = '~' + s.slice(home.length);
  if (s.length > 42) s = '…' + s.slice(-40);
  return s.replace(/\\/g, '/');
}

export function toolCard(name, detail, status, result, showDetails = false) {
  const st =
    status === 'awaiting'
      ? t.yellow('approval required')
      : status === 'running'
        ? t.yellow('running')
      : status === 'ok'
        ? ''
        : status === 'denied'
          ? t.red('denied')
          : status === 'error'
            ? t.red('error')
            : t.dim(status || '');
  const width = Math.max(12, termWidth() - 9);
  const detailText = String(detail || '').replace(/\s+/g, ' ').trim();
  const marker = status === 'awaiting' ? t.yellow('○') : status === 'running' ? t.yellow('●') : status === 'ok' ? t.green('✓') : t.red('✗');
  const label = toolLabel(name);
  const complete = status === 'ok' || status === 'denied' || status === 'error';
  const preview = result ? resultPreview(name, result) : '';
  const summary = preview || detailText;
  const diff = result?.diff;
  let statsText = '';
  if (diff && (diff.additions || diff.deletions)) {
    const bits = [];
    if (diff.additions) bits.push(t.green(`+${diff.additions}`));
    if (diff.deletions) bits.push(t.red(`-${diff.deletions}`));
    statsText = `  ${bits.join(' ')}`;
  }
  let heading = `  ${t.border(complete ? '╰─' : '├─')} ${marker} ${t.tool(label)}${st ? `  ${st}` : ''}`;
  if (complete && summary && status === 'ok') {
    heading += `  ${t.dim(wrapAnsi(summary, Math.max(8, width - 22))[0])}${statsText}`;
  } else if (statsText) {
    heading += statsText;
  }
  const rows = [heading];
  if (detailText && (showDetails || status === 'awaiting')) {
    rows.push(...wrapAnsi(detailText, width).map((line) => `  ${t.border('│')}  ${t.dim(line)}`));
  }
  if (preview && (showDetails || status === 'error' || status === 'denied') && !diff?.lines?.length) {
    rows.push(...wrapAnsi(preview, width).map((line) => `  ${t.border('│')}  ${status === 'error' ? t.red(line) : t.dim(line)}`));
  }
  // Always show edit/write before→after when available (OpenCode-style).
  // No tree gutter on diff lines so drag-select stays clean.
  if (complete && status === 'ok' && diff?.lines?.length) {
    const painted = paintDiffLinesFromModule(diff.lines, width);
    rows.push(...painted.map((line) => `  ${line}`));
    if (diff.truncated) rows.push(`  ${t.dim('… diff truncated')}`);
  }
  return rows.join('\n');
}

function paintDiffLinesFromModule(lines, width) {
  // Lazy import avoided — keep draw.js free of cycles by inlining a thin paint using theme.
  const max = Math.max(12, width - 4);
  const out = [];
  for (const line of (lines || []).slice(0, 48)) {
    const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
    let body = `${marker} ${line.text ?? ''}`;
    if (body.length > max) body = `${body.slice(0, max - 1)}…`;
    if (line.type === 'add') out.push(t.green(body));
    else if (line.type === 'del') out.push(t.red(body));
    else out.push(t.dim(body));
  }
  return out;
}

export function userBubble(text) {
  const width = Math.max(12, termWidth() - 4);
  const lines = wrapAnsi(String(text), width);
  // Role label on its own line so multi-line drag-select does not include ▌ gutters.
  return `\n${t.dim(t.user('you'))}\n${lines.map((line) => t.user(line)).join('\n')}\n`;
}

export function agentPrefix() {
  return t.accent('  ✦ cheapai');
}

export function thinkingLine(turn) {
  return `${t.yellow('  ┊')} ${t.dim(`Thinking${turn ? ` · turn ${turn}` : ''}`)}`;
}

export function footerHints(extra = []) {
  const base = ['Enter send', '/help', '/exit'];
  const hints = [...base, ...extra];
  const width = termWidth() - 4;
  const lines = [];
  let line = '';
  for (const hint of hints) {
    const next = line ? `${line}  ·  ${hint}` : hint;
    if (line && displayWidth(next) > width) {
      lines.push(line);
      line = hint;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.map((value) => t.dim(`  ${value}`)).join('\n');
}

export function permissionLabel(mode) {
  if (mode === 'yolo') return t.yellow('all tools');
  if (mode === 'accept-edits') return t.cyan('edits allowed');
  return t.dim('ask for writes');
}

function compactPermissionLabel(mode) {
  if (mode === 'yolo') return t.yellow('all');
  if (mode === 'accept-edits') return t.cyan('edits');
  return t.dim('guarded');
}

function toolLabel(name) {
  const labels = {
    bash: 'Bash',
    read_file: 'Read',
    write_file: 'Write',
    edit_file: 'Edit',
    glob: 'Glob',
    grep: 'Grep',
    todo_write: 'Tasks',
    git: 'Git',
    web_fetch: 'Fetch',
    ask_question: 'Ask',
    task: 'Task',
    project_docs: 'Docs',
    skill: 'Skill',
    mcp_manage: 'MCP',
    list_mcp_tools: 'MCP',
    call_mcp_tool: 'MCP',
  };
  return labels[name] || name;
}

function resultPreview(name, result) {
  if (result.error) return `error: ${String(result.error).replace(/\s+/g, ' ').slice(0, 160)}`;
  if (result.stdout || result.stderr) {
    const text = String(result.stderr || result.stdout).trim().replace(/\s+/g, ' ');
    if (text) return `output: ${text.slice(0, 160)}${text.length > 160 ? '…' : ''}`;
  }
  if (result.path) {
    if (name === 'read_file') return `read ${shortPath(result.path)}`;
    if (name === 'edit_file' || name === 'write_file') return shortPath(result.path);
    return `updated ${shortPath(result.path)}`;
  }
  if (Array.isArray(result.files)) return `${result.files.length} file${result.files.length === 1 ? '' : 's'} found`;
  if (Array.isArray(result.matches)) return `${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} found`;
  if (name === 'git' && result.branch) {
    const dirty = Array.isArray(result.files) ? result.files.length : 0;
    return `${result.branch}${dirty ? ` · ${dirty} change${dirty === 1 ? '' : 's'}` : ''}`;
  }
  if (name === 'web_fetch' && (result.title || result.finalUrl || result.url)) {
    return result.title || result.finalUrl || result.url;
  }
  return '';
}

function clip(value, max) {
  const text = String(value);
  if (displayWidth(text) <= max) return text;
  let out = '';
  for (const char of text) {
    if (displayWidth(out + char + '…') > max) break;
    out += char;
  }
  return `${out}…`;
}

function isWideCodePoint(code) {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f1e6 && code <= 0x1f1ff) ||
      (code >= 0x1f300 && code <= 0x1faff))
  );
}
