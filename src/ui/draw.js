import { t } from './theme.js';

export function termWidth() {
  return Math.min(process.stdout.columns || 80, 100);
}

export function clearScreen() {
  // clear + home (works in Windows Terminal / modern PS)
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
  const w = Math.min(termWidth(), 78);
  const out = [];
  out.push(t.border(`╭${'─'.repeat(w - 2)}╮`));
  if (title) {
    out.push(t.border('│ ') + t.bold(t.accent(title)) + t.border(` ${' '.repeat(Math.max(0, w - 4 - stripAnsi(title).length))}│`));
    out.push(t.border(`├${'─'.repeat(w - 2)}┤`));
  }
  for (const line of bodyLines) {
    const s = String(line);
    out.push(t.border('│ ') + s);
  }
  out.push(t.border(`╰${'─'.repeat(w - 2)}╯`));
  return out.join('\n');
}

export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

export function bannerLogo() {
  // Compact ASCII inspired by coding-agent TUIs
  const lines = [
    t.accent('   ██████╗██╗  ██╗███████╗ █████╗ ██████╗  █████╗ ██╗'),
    t.accent('  ██╔════╝██║  ██║██╔════╝██╔══██╗██╔══██╗██╔══██╗██║'),
    t.accent('  ██║     ███████║█████╗  ███████║██████╔╝███████║██║'),
    t.accent('  ██║     ██╔══██║██╔══╝  ██╔══██║██╔═══╝ ██╔══██║██║'),
    t.accent('  ╚██████╗██║  ██║███████╗██║  ██║██║     ██║  ██║██║'),
    t.accent('   ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚═╝'),
  ];
  // Fallback small wordmark if terminal is narrow
  if (termWidth() < 60) {
    return t.bold(t.accent('  cheapai')) + t.dim('  coding agent');
  }
  return lines.join('\n');
}

export function statusBar({ model, mode, cwd, user, session }) {
  const parts = [
    t.accent('cheapai'),
    t.dim('│'),
    t.cyan(model || '—'),
    t.dim('│'),
    mode === 'yolo' ? t.yellow('yolo') : t.dim(mode || 'ask'),
    t.dim('│'),
    t.dim(shortPath(cwd || process.cwd())),
  ];
  if (user) parts.push(t.dim('│'), t.green(user));
  if (session) parts.push(t.dim('│'), t.dim(session.slice(0, 8)));
  return parts.join(' ');
}

export function shortPath(p) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  let s = p;
  if (home && s.startsWith(home)) s = '~' + s.slice(home.length);
  if (s.length > 36) s = '…' + s.slice(-34);
  return s.replace(/\\/g, '/');
}

export function toolCard(name, detail, status) {
  const st =
    status === 'running'
      ? t.yellow('running')
      : status === 'ok'
        ? t.green('done')
        : status === 'denied'
          ? t.red('denied')
          : status === 'error'
            ? t.red('error')
            : t.dim(status || '');
  const d = String(detail || '').replace(/\s+/g, ' ').slice(0, 64);
  return (
    t.border('  ╭─ ') +
    t.tool(`⚙ ${name}`) +
    t.border(' ──') +
    '\n' +
    t.border('  │ ') +
    t.dim(d) +
    '\n' +
    t.border('  ╰─ ') +
    st
  );
}

export function userBubble(text) {
  return '\n' + t.user('  ╭ you') + '\n' + t.user('  │ ') + text.split('\n').join('\n' + t.user('  │ ')) + '\n';
}

export function agentPrefix() {
  return t.accent('  ✦ cheapai');
}

export function thinkingLine(turn) {
  return t.dim(`  ● thinking${turn ? ` · turn ${turn}` : ''}…`);
}

export function footerHints(extra = []) {
  const base = ['Enter send', '/help', '/exit', 'Shift+Tab mode'];
  return t.dim('  ' + [...base, ...extra].join('  ·  '));
}
