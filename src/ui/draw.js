import { t } from './theme.js';

export function termWidth() {
  return Math.max(20, Math.min(process.stdout.columns || 80, 110));
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

export function box(lines, { title, width } = {}) {
  const w = width || Math.min(termWidth() - 2, 72);
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
  const w = Math.max(18, Math.min(termWidth() - 2, 82));
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
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === 0x200d || (code >= 0x300 && code <= 0x36f)) continue;
    width += isWideCodePoint(code) ? 2 : 1;
  }
  return width;
}

export function sanitizeTerminalText(value) {
  return stripAnsi(value)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
    for (const token of tokens) {
      const isAnsi = token.startsWith('\x1b[');
      if (isAnsi) active = token === t.reset ? '' : active + token;
      const next = isAnsi ? 0 : displayWidth(token);
      if (cells && cells + next > max) {
        lines.push(active ? line + t.reset : line);
        line = active;
        cells = 0;
      }
      line += token;
      cells += next;
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
  const width = Math.max(12, Math.min(termWidth() - 9, 82));
  const detailText = String(detail || '').replace(/\s+/g, ' ').trim();
  const marker = status === 'awaiting' ? t.yellow('○') : status === 'running' ? t.yellow('●') : status === 'ok' ? t.green('✓') : t.red('✗');
  const label = toolLabel(name);
  const complete = status === 'ok' || status === 'denied' || status === 'error';
  const preview = result ? resultPreview(name, result) : '';
  const summary = preview || detailText;
  let heading = `  ${t.border(complete ? '╰─' : '├─')} ${marker} ${t.tool(label)}${st ? `  ${st}` : ''}`;
  if (complete && summary && !showDetails && status === 'ok') {
    heading += `  ${t.dim(wrapAnsi(summary, Math.max(8, width - 18))[0])}`;
  }
  const rows = [heading];
  if (detailText && (showDetails || status === 'awaiting')) {
    rows.push(...wrapAnsi(detailText, width).map((line) => `  ${t.border('│')}  ${t.dim(line)}`));
  }
  if (preview) {
    if (preview && (showDetails || status === 'error' || status === 'denied')) {
      rows.push(...wrapAnsi(preview, width).map((line) => `  ${t.border('│')}  ${status === 'error' ? t.red(line) : t.dim(line)}`));
    }
  }
  return rows.join('\n');
}

export function userBubble(text) {
  const width = Math.max(12, Math.min(termWidth() - 7, 82));
  const lines = wrapAnsi(String(text), width);
  return '\n' + lines.map((line) => `${t.user('  ▌')} ${line}`).join('\n') + '\n';
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
  };
  return labels[name] || name;
}

function resultPreview(name, result) {
  if (result.error) return `error: ${String(result.error).replace(/\s+/g, ' ').slice(0, 160)}`;
  if (result.stdout || result.stderr) {
    const text = String(result.stderr || result.stdout).trim().replace(/\s+/g, ' ');
    if (text) return `output: ${text.slice(0, 160)}${text.length > 160 ? '…' : ''}`;
  }
  if (result.path) return `${name === 'read_file' ? 'read' : 'updated'} ${shortPath(result.path)}`;
  if (Array.isArray(result.files)) return `${result.files.length} file${result.files.length === 1 ? '' : 's'} found`;
  if (Array.isArray(result.matches)) return `${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} found`;
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
