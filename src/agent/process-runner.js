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
  const child = spawn(shell, args, {
    cwd,
    env,
    windowsHide: true,
    detached: platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = createBoundedCollector(maxStdoutBytes);
  const stderr = createBoundedCollector(maxStderrBytes);

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
  if (platform === 'win32') return [env.ComSpec || 'cmd.exe', ['/c', command]];
  return ['bash', ['-lc', command]];
}

export function safeChildEnvironment(source = process.env) {
  const env = { ...source };
  for (const name of ['CHEAPAI_API_KEY', 'CHEAPSUB_API_KEY', 'OPENAI_API_KEY']) delete env[name];
  return env;
}

function createBoundedCollector(maxBytes) {
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
      return Buffer.concat(chunks, bytes).toString('utf8');
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
