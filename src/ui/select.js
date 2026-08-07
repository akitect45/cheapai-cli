/**
 * Simple, reliable keyboard menu (Grok-like list).
 * Mouse support is best-effort; never auto-selects without Enter.
 */

import readline from 'node:readline';
import { t } from './theme.js';

/**
 * @param {{ title?: string, subtitle?: string, options: Array<{id:string,label:string,hint?:string,action?:string}>, initialIndex?: number }} opts
 * @returns {Promise<object|null>}
 */
export async function selectMenu({
  title,
  subtitle,
  options,
  footer = '↑/↓  move   Enter  select   1-9  shortcut   q  quit',
  initialIndex = 0,
} = {}) {
  if (!options?.length) return null;

  // Non-TTY fallback
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return numberPrompt(options, initialIndex);
  }

  let index = Math.max(0, Math.min(initialIndex, options.length - 1));
  const linesUsed = () =>
    (title ? 1 : 0) + (subtitle ? 1 : 0) + (title || subtitle ? 1 : 0) + options.length + 2;

  function paint(first = false) {
    if (!first) {
      process.stdout.write(`\x1b[${linesUsed()}A\x1b[0J`);
    }
    const out = [];
    if (title) out.push(t.bold(`  ${title}`));
    if (subtitle) out.push(t.dim(`  ${subtitle}`));
    if (title || subtitle) out.push('');
    options.forEach((opt, i) => {
      const on = i === index;
      const arrow = on ? t.accent('❯') : ' ';
      const label = on ? t.bold(opt.label) : opt.label;
      const hint = opt.hint ? t.dim(`  ${opt.hint}`) : '';
      const num = t.dim(`${i + 1}.`);
      out.push(`  ${arrow} ${num} ${label}${hint}`);
    });
    out.push('');
    out.push(t.dim(`  ${footer}`));
    process.stdout.write(out.join('\n') + '\n');
  }

  process.stdout.write('\x1b[?25l'); // hide cursor
  paint(true);

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let buf = '';

    function done(value) {
      stdin.setRawMode?.(!!wasRaw);
      stdin.removeListener('data', onData);
      process.stdout.write('\x1b[?25h'); // show cursor
      process.stdout.write('\n');
      resolve(value);
    }

    function onData(chunk) {
      buf += chunk;

      // strip mouse sequences if any terminal sends them — ignore (no auto click)
      buf = buf.replace(/\x1b\[<?\d+(?:;\d+)*[Mm]/g, '');
      buf = buf.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, '');

      while (buf.length) {
        if (buf.startsWith('\x1b[')) {
          if (buf.length < 3) return;
          const code = buf[2];
          buf = buf.slice(3);
          if (code === 'A') {
            index = (index - 1 + options.length) % options.length;
            paint();
          } else if (code === 'B') {
            index = (index + 1) % options.length;
            paint();
          }
          continue;
        }
        if (buf[0] === '\x1b') {
          // wait for full sequence or treat as cancel
          if (buf.length === 1) return;
          buf = buf.slice(1);
          continue;
        }

        const ch = buf[0];
        buf = buf.slice(1);

        if (ch === '\r' || ch === '\n') {
          done(options[index]);
          return;
        }
        if (ch === 'q' || ch === 'Q' || ch === '\u0003') {
          done(null);
          return;
        }
        if (ch === 'j') {
          index = (index + 1) % options.length;
          paint();
          continue;
        }
        if (ch === 'k') {
          index = (index - 1 + options.length) % options.length;
          paint();
          continue;
        }
        if (ch >= '1' && ch <= '9') {
          const n = Number(ch) - 1;
          if (n < options.length) {
            done(options[n]);
            return;
          }
        }
      }
    }

    stdin.on('data', onData);
  });
}

function numberPrompt(options, initialIndex) {
  return new Promise((resolve) => {
    options.forEach((o, i) => {
      console.log(`  ${i + 1}) ${o.label}${o.hint ? ' — ' + o.hint : ''}`);
    });
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('  ❯ ', (ans) => {
      rl.close();
      const n = parseInt(String(ans).trim(), 10);
      if (n >= 1 && n <= options.length) resolve(options[n - 1]);
      else resolve(options[initialIndex] || options[0]);
    });
  });
}
