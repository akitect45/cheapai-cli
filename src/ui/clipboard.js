import { spawn } from 'node:child_process';

/**
 * Copy text to the system clipboard.
 * Tries native tools first, then OSC 52 (works over many SSH/terminal setups — same idea as Grok).
 */
export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;
  const native = await copyNative(value);
  // Always emit OSC 52 as a belt-and-suspenders route (Grok-style multi-path clipboard).
  writeOsc52(value);
  return native || process.stdout.isTTY === true;
}

function writeOsc52(text) {
  if (!process.stdout.isTTY || process.env.TERM === 'dumb') return;
  try {
    // Cap payload; huge pastes can hang weak terminals.
    const payload = Buffer.from(text, 'utf8').subarray(0, 100_000).toString('base64');
    process.stdout.write(`\x1b]52;c;${payload}\x07`);
  } catch {
    /* ignore */
  }
}

function copyNative(text) {
  const [command, args] = process.platform === 'darwin'
    ? ['pbcopy', []]
    : process.platform === 'win32'
      ? ['clip', []]
      : process.env.WAYLAND_DISPLAY
        ? ['wl-copy', []]
        : ['xclip', ['-selection', 'clipboard']];
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('close', (code) => resolve(code === 0));
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}
