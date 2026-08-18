import { spawn } from 'node:child_process';
import { processStartIdentity } from './session-lock.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STDOUT_BYTES = 200_000;
const DEFAULT_STDERR_BYTES = 100_000;
const TERMINATION_GRACE_MS = 500;

export async function runProcess({
  command,
  cwd,
  signal = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxStdoutBytes = DEFAULT_STDOUT_BYTES,
  maxStderrBytes = DEFAULT_STDERR_BYTES,
  env = safeChildEnvironment(process.env),
  onStart = null,
  platform = process.platform,
} = {}) {
  if (signal?.aborted) return terminalResult({ aborted: true });
  const [shell, args] = shellInvocation(command, platform, env);
  const childEnv = platform === 'win32' ? utf8ChildEnvironment(env) : env;
  const child = spawn(shell, args, {
    cwd,
    env: childEnv,
    windowsHide: true,
    windowsVerbatimArguments: platform === 'win32',
    detached: platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = createBoundedCollector(maxStdoutBytes, platform);
  const stderr = createBoundedCollector(maxStderrBytes, platform);

  return new Promise((resolve) => {
    let settled = false;
    let termination = null;
    let startError = null;
    let forceTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      resolve(terminalResult({
        ...result,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdout_truncated: stdout.truncated(),
        stderr_truncated: stderr.truncated(),
      }));
    };

    const terminate = (reason) => {
      if (termination) return;
      termination = reason;
      terminateProcessTree(child, platform, 'SIGTERM');
      forceTimer = setTimeout(() => {
        terminateProcessTree(child, platform, 'SIGKILL');
        finish(reason === 'abort' ? { aborted: true } : { timed_out: true });
      }, TERMINATION_GRACE_MS);
      forceTimer.unref?.();
    };
    const abort = () => terminate('abort');
    const timeoutTimer = setTimeout(() => terminate('timeout'), clampTimeout(timeoutMs));
    timeoutTimer.unref?.();

    child.stdout?.on('data', stdout.append);
    child.stderr?.on('data', stderr.append);
    child.once('spawn', () => {
      try {
        onStart?.({
          pid: child.pid,
          processStartId: processStartIdentity(child.pid, platform),
          command: String(command).slice(0, 500),
        });
      } catch (error) {
        startError = error;
        terminate('journal_error');
      }
    });
    child.once('error', (error) => finish({ error: String(error?.message || error) }));
    child.once('close', (exitCode, exitSignal) => {
      if (termination === 'journal_error') finish({ error: String(startError?.message || startError) });
      else if (termination === 'abort') finish({ aborted: true, exit_code: exitCode, signal: exitSignal });
      else if (termination === 'timeout') finish({ timed_out: true, exit_code: exitCode, signal: exitSignal });
      else finish({ ok: exitCode === 0, exit_code: exitCode, signal: exitSignal });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function terminateProcessTree(child, platform = process.platform, signal = 'SIGTERM') {
  if (!child?.pid) return;
  if (platform === 'win32') {
    if (signal === 'SIGKILL') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.unref();
    } else {
      child.kill('SIGTERM');
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* The process has already exited. */
    }
  }
}

export function terminateRecordedProcess(record, platform = process.platform) {
  if (!record?.pid || !record?.processStartId) return false;
  if (processStartIdentity(record.pid, platform) !== record.processStartId) return false;
  if (platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(record.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.unref();
    return true;
  }
  try {
    process.kill(-Number(record.pid), 'SIGTERM');
    const forceTimer = setTimeout(() => {
      if (processStartIdentity(record.pid, platform) !== record.processStartId) return;
      try {
        process.kill(-Number(record.pid), 'SIGKILL');
      } catch {
        try {
          process.kill(Number(record.pid), 'SIGKILL');
        } catch {
          /* The process exited during the grace period. */
        }
      }
    }, TERMINATION_GRACE_MS);
    forceTimer.unref?.();
    return true;
  } catch {
    try {
      process.kill(Number(record.pid), 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}

export function shellInvocation(command, platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const text = String(command || '');
    // Prefix UTF-8 code page. Do not re-wrap quoted executables — after `chcp &`
    // an extra outer quote pair breaks `cmd /s /c` parsing (e.g. node -e scripts).
    const wrapped = `chcp 65001>nul 2>&1 & ${text}`;
    return [env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', wrapped]];
  }
  return ['bash', ['-lc', command]];
}

export function safeChildEnvironment(source = process.env) {
  const env = { ...source };
  for (const name of ['CHEAPAI_API_KEY', 'CHEAPSUB_API_KEY', 'OPENAI_API_KEY']) delete env[name];
  return env;
}

/** Encourage child tools to emit UTF-8 on Windows. */
export function utf8ChildEnvironment(source = process.env) {
  const env = { ...source };
  env.PYTHONIOENCODING = env.PYTHONIOENCODING || 'utf-8';
  env.PYTHONUTF8 = env.PYTHONUTF8 || '1';
  env.LANG = env.LANG || 'C.UTF-8';
  env.LC_ALL = env.LC_ALL || 'C.UTF-8';
  // Node itself when used as a child
  env.NODE_OPTIONS = env.NODE_OPTIONS || '';
  return env;
}

/**
 * Decode process output: prefer valid UTF-8, fall back to Korean Windows code pages.
 * Official Node builds with full ICU support `euc-kr` / related labels.
 */
export function decodeConsoleBuffer(buffer, platform = process.platform) {
  const buf = trimIncompleteUtf8(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || ''));
  if (!buf.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    /* not strict utf-8 */
  }
  if (platform === 'win32') {
    for (const encoding of ['euc-kr', 'windows-949', 'ibm949', 'iso-8859-1']) {
      try {
        return new TextDecoder(encoding).decode(buf);
      } catch {
        /* try next */
      }
    }
  }
  return buf.toString('utf8');
}

/**
 * Drop leading UTF-8 continuation bytes and a trailing incomplete sequence
 * so a byte-capped collector cannot mis-decode Korean as latin-1/CP949.
 */
export function trimIncompleteUtf8(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (!buf.length) return buf;
  let start = 0;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  if (start >= buf.length) return buf.subarray(0, 0);
  let end = buf.length;
  if ((buf[end - 1] & 0x80) === 0) return buf.subarray(start, end);
  let seq = end - 1;
  while (seq > start && (buf[seq] & 0xc0) === 0x80) seq -= 1;
  const lead = buf[seq];
  const needed = (lead & 0xe0) === 0xc0 ? 2
    : (lead & 0xf0) === 0xe0 ? 3
      : (lead & 0xf8) === 0xf0 ? 4
        : (lead & 0x80) === 0 ? 1
          : 0;
  if (!needed || end - seq < needed) end = seq;
  return buf.subarray(start, end);
}

function createBoundedCollector(maxBytes, platform = process.platform) {
  const limit = Math.max(1024, Number(maxBytes) || 0);
  let chunks = [];
  let bytes = 0;
  let clipped = false;
  return {
    append(chunk) {
      const value = Buffer.from(chunk);
      chunks.push(value);
      bytes += value.length;
      while (bytes > limit && chunks.length) {
        const excess = bytes - limit;
        const first = chunks[0];
        if (first.length <= excess) {
          chunks.shift();
          bytes -= first.length;
        } else {
          chunks[0] = first.subarray(excess);
          bytes -= excess;
        }
        clipped = true;
      }
    },
    text() {
      return decodeConsoleBuffer(Buffer.concat(chunks, bytes), platform);
    },
    truncated() {
      return clipped;
    },
  };
}

function terminalResult(values = {}) {
  return {
    ok: false,
    exit_code: null,
    signal: null,
    timed_out: false,
    aborted: false,
    stdout: '',
    stderr: '',
    stdout_truncated: false,
    stderr_truncated: false,
    ...values,
  };
}

function clampTimeout(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout)) return DEFAULT_TIMEOUT_MS;
  return Math.min(30 * 60_000, Math.max(1, timeout));
}
