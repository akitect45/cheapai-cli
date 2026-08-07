/**
 * Simple, reliable keyboard menu for focused terminal pickers.
 * Mouse support is best-effort; never auto-selects without Enter.
 */

import readline from 'node:readline';
import { t } from './theme.js';
import { displayWidth, sanitizeTerminalText, termWidth } from './draw.js';

/**
 * @param {{ title?: string, subtitle?: string, headerLines?: string[], centered?: boolean, alternateScreen?: boolean, options: Array<{id?:string,label:string,hint?:string,action?:string,aliases?:string[]}>, initialIndex?: number, searchable?: boolean }} opts
 * @returns {Promise<object|null>}
 */
export async function selectMenu({
  title,
  subtitle,
  headerLines = [],
  centered = false,
  alternateScreen = false,
  options,
  footer = '↑/↓  move   Enter  select   1-9  shortcut   q  quit',
  initialIndex = 0,
  searchable = false,
} = {}) {
  if (!options?.length) return null;

  // Non-TTY fallback
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return numberPrompt(options, initialIndex);
  }

  let index = Math.max(0, Math.min(initialIndex, options.length - 1));
  let paintedLines = 0;
  let query = '';
  let escapeTimer = null;

  function visibleOptions() {
    if (!query) return options;
    const needle = query.toLowerCase();
    return options.filter((option) => `${option.label} ${option.hint || ''}`.toLowerCase().includes(needle));
  }

  function paint(first = false) {
    if (!first && paintedLines) {
      process.stdout.write(`\x1b[${paintedLines}A\x1b[0J`);
    }
    const narrow = termWidth() < 58;
    const filtered = visibleOptions();
    index = Math.max(0, Math.min(index, Math.max(0, filtered.length - 1)));
    const viewport = Math.max(5, Math.min(10, (process.stdout.rows || 24) - 8));
    const start = Math.max(0, Math.min(index - Math.floor(viewport / 2), filtered.length - viewport));
    const visible = filtered.slice(start, start + viewport);
    const out = [...headerLines];
    if (headerLines.length && (title || subtitle || options.length)) out.push('');
    if (title) out.push(t.bold(`  ${clipCells(title, Math.max(8, termWidth() - 4))}`));
    if (subtitle) out.push(t.dim(`  ${clipCells(subtitle, Math.max(8, termWidth() - 4))}`));
    if (searchable) out.push(`${t.accent('  /')} ${query ? clipCells(query, Math.max(6, termWidth() - 6)) : t.dim('type to filter')}`);
    if (title || subtitle) out.push('');
    if (start > 0) out.push(t.dim(`  ↑ ${start} more`));
    visible.forEach((opt, visibleIndex) => {
      const i = start + visibleIndex;
      const on = i === index;
      const arrow = on ? t.accent('▌') : ' ';
      const hintText = opt.hint && !narrow ? clipCells(opt.hint, 24) : '';
      const labelWidth = Math.max(8, termWidth() - displayWidth(hintText) - 14);
      const labelText = clipCells(opt.label, labelWidth);
      const label = on ? t.bold(labelText) : labelText;
      const hint = hintText ? t.dim(`  ${hintText}`) : '';
      const num = t.dim(`${i + 1}.`);
      out.push(`  ${arrow} ${num} ${label}${hint}`);
    });
    if (!filtered.length) out.push(t.dim('  No matches'));
    const remaining = filtered.length - start - visible.length;
    if (remaining > 0) out.push(t.dim(`  ↓ ${remaining} more`));
    out.push('');
    const footerText = narrow
      ? searchable
        ? 'type filter  ·  ↑/↓ move  ·  Enter select  ·  Esc cancel'
        : '↑/↓ move  ·  Enter select  ·  q quit'
      : footer;
    out.push(t.dim(`  ${clipCells(footerText, Math.max(8, termWidth() - 4))}`));
    const visibleOut = centered ? centerBlock(out) : out;
    const topPadding = centered ? Math.max(0, Math.floor(((process.stdout.rows || 24) - visibleOut.length) / 2) - 1) : 0;
    const rendered = [...Array(topPadding).fill(''), ...visibleOut];
    paintedLines = rendered.length;
    process.stdout.write(rendered.join('\n') + '\n');
  }

  if (alternateScreen) process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
  process.stdout.write('\x1b[?25l'); // hide cursor
  paint(true);

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    const wasFlowing = stdin.readableFlowing;
    const cleanup = () => {
      clearTimeout(escapeTimer);
      stdin.setRawMode?.(!!wasRaw);
      stdin.removeListener('data', onData);
      if (wasFlowing !== true) stdin.pause();
      process.stdout.write('\x1b[?25h');
      if (alternateScreen) process.stdout.write('\x1b[?1049l');
    };
    const onSigterm = () => {
      cleanup();
      process.exit(143);
    };
    const onExit = () => cleanup();
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    process.once('SIGTERM', onSigterm);
    process.once('exit', onExit);

    let buf = '';

    function done(value) {
      cleanup();
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('exit', onExit);
      if (!alternateScreen) process.stdout.write('\n');
      resolve(value);
    }

    function onData(chunk) {
      clearTimeout(escapeTimer);
      buf += chunk;

      // strip mouse sequences if any terminal sends them — ignore (no auto click)
      buf = buf.replace(/\x1b\[<?\d+(?:;\d+)*[Mm]/g, '');
      buf = buf.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, '');

      while (buf.length) {
        if (buf.startsWith('\x1b[')) {
          if (buf.length < 3) return;
          const code = buf[2];
          buf = buf.slice(3);
          const filtered = visibleOptions();
          if (code === 'A') {
            if (filtered.length) index = (index - 1 + filtered.length) % filtered.length;
            paint();
          } else if (code === 'B') {
            if (filtered.length) index = (index + 1) % filtered.length;
            paint();
          }
          continue;
        }
        if (buf[0] === '\x1b') {
          // A bare Escape cancels; arrow sequences are handled above.
          if (buf.length === 1) {
            clearTimeout(escapeTimer);
            escapeTimer = setTimeout(() => {
              if (buf !== '\x1b') return;
              buf = '';
              if (query) {
                query = '';
                index = 0;
                paint();
              } else {
                done(null);
              }
            }, 80);
            escapeTimer.unref?.();
            return;
          }
          buf = buf.slice(1);
          continue;
        }

        const ch = buf[0];
        buf = buf.slice(1);

        if (ch === '\r' || ch === '\n') {
          const filtered = visibleOptions();
          if (filtered.length) done(filtered[index]);
          return;
        }
        if ((!searchable && (ch === 'q' || ch === 'Q')) || ch === '\u0003') {
          done(null);
          return;
        }
        if (searchable && (ch === '\u007f' || ch === '\b')) {
          query = query.slice(0, -1);
          index = 0;
          paint();
          continue;
        }
        if (searchable && ch === '\u0015') {
          query = '';
          index = 0;
          paint();
          continue;
        }
        if (ch === 'j') {
          if (searchable) {
            query += ch;
            index = 0;
          } else {
            index = (index + 1) % options.length;
          }
          paint();
          continue;
        }
        if (ch === 'k') {
          if (searchable) {
            query += ch;
            index = 0;
          } else {
            index = (index - 1 + options.length) % options.length;
          }
          paint();
          continue;
        }
        if (!searchable && ch >= '1' && ch <= '9') {
          const n = Number(ch) - 1;
          if (n < options.length) {
            done(options[n]);
            return;
          }
        }
        if (searchable && ch >= ' ') {
          query += ch;
          index = 0;
          paint();
        }
      }
    }

    stdin.on('data', onData);
  });
}

function numberPrompt(options) {
  return new Promise((resolve) => {
    options.forEach((o, i) => {
      const label = sanitizeTerminalText(o.label);
      const hint = o.hint ? ` — ${sanitizeTerminalText(o.hint)}` : '';
      console.log(`  ${i + 1}) ${label}${hint}`);
    });
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('  ❯ ', (ans) => {
      rl.close();
      resolve(resolveMenuAnswer(options, ans));
    });
  });
}

export function resolveMenuAnswer(options, answer) {
  const value = String(answer || '').trim().toLowerCase();
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
  return options.find((option) => {
    const aliases = option.aliases || [];
    return option.action?.toLowerCase() === value || option.label.toLowerCase() === value || aliases.includes(value);
  }) || null;
}

function clipCells(value, maxWidth) {
  const text = sanitizeTerminalText(value);
  if (displayWidth(text) <= maxWidth) return text;
  let out = '';
  for (const char of text) {
    if (displayWidth(out + char + '…') > maxWidth) break;
    out += char;
  }
  return `${out}…`;
}

function centerBlock(lines) {
  const screenWidth = Math.max(20, process.stdout.columns || termWidth());
  const blockWidth = Math.min(termWidth(), Math.max(...lines.map(displayWidth), 1));
  const left = Math.max(0, Math.floor((screenWidth - blockWidth) / 2));
  return lines.map((line) => `${' '.repeat(left)}${line}`);
}
