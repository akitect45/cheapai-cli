import { spawn } from 'node:child_process';

export function copyText(text) {
  const [command, args] = process.platform === 'darwin'
    ? ['pbcopy', []]
    : process.platform === 'win32'
      ? ['clip', []]
      : ['xclip', ['-selection', 'clipboard']];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
    child.stdin.end(String(text || ''));
  });
}
