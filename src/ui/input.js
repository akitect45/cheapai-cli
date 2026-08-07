import { t } from './theme.js';

export function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    return readPipedSecret();
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    const wasFlowing = stdin.readableFlowing;
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode?.(!!wasRaw);
      if (wasFlowing !== true) stdin.pause();
      process.stdout.write('\n');
    };
    const onSigterm = () => {
      cleanup();
      process.exit(143);
    };
    const onExit = () => cleanup();
    let value = '';
    let masked = false;

    process.stdout.write(prompt + t.dim('(input hidden) '));
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    process.once('SIGTERM', onSigterm);
    process.once('exit', onExit);

    function finish(error) {
      cleanup();
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve(value.trim());
    }

    function onData(chunk) {
      const clean = chunk.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      for (const char of clean) {
        if (char === '\u0003') {
          finish(new Error('Cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          if (!value && masked) {
            process.stdout.write('\b \b'.repeat(6));
            masked = false;
          }
          continue;
        }
        if (char === '\u0015') {
          value = '';
          if (masked) process.stdout.write('\b \b'.repeat(6));
          masked = false;
          continue;
        }
        if (char >= ' ') {
          value += char;
          if (!masked) {
            process.stdout.write(t.dim('••••••'));
            masked = true;
          }
        }
      }
    }

    stdin.on('data', onData);
  });
}

async function readPipedSecret() {
  let value = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}
