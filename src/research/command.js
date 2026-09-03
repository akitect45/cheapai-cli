import fs from 'node:fs';
import path from 'node:path';

const SCRIPT_SH = 'autoresearch.sh';
const SCRIPT_CMD = 'autoresearch.cmd';
const SCRIPT_PS1 = 'autoresearch.ps1';

export function resolveHarnessCommand({
  cwd,
  preferredCommand,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const trimmed = typeof preferredCommand === 'string' ? preferredCommand.trim() : '';
  if (trimmed) return { ok: true, command: trimmed, source: 'preferred' };

  const root = path.resolve(cwd || process.cwd());
  const has = (name) => existsSync(path.join(root, name));

  if (platform === 'win32') {
    if (has(SCRIPT_CMD)) return { ok: true, command: SCRIPT_CMD, source: SCRIPT_CMD };
    if (has(SCRIPT_PS1)) return { ok: true, command: `powershell -NoProfile -File ${SCRIPT_PS1}`, source: SCRIPT_PS1 };
    if (has(SCRIPT_SH)) return { ok: true, command: `bash ${SCRIPT_SH}`, source: SCRIPT_SH };
  } else {
    if (has(SCRIPT_SH)) return { ok: true, command: `bash ${SCRIPT_SH}`, source: SCRIPT_SH };
    if (has(SCRIPT_CMD)) return { ok: true, command: SCRIPT_CMD, source: SCRIPT_CMD };
  }

  return {
    ok: false,
    command: null,
    source: null,
    error: 'harness_command_missing',
  };
}
