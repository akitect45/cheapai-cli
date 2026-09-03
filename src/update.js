import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureHome } from './config.js';
import { VERSION } from './ui/theme.js';

const PACKAGE_NAME = '@akitect/cheapai';
const REGISTRY_URL = 'https://registry.npmjs.org/%40akitect%2Fcheapai';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SAFE_PACKAGE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
export const UPDATE_REQUEST_TIMEOUT_MS = 2_500;
const INSTALL_TIMEOUT_MS = 2 * 60 * 1000;

export function safePackageVersion(version) {
  const value = String(version || '').trim().replace(/^v/i, '');
  if (!SAFE_PACKAGE_VERSION.test(value)) {
    throw new Error('업데이트 버전 형식이 올바르지 않습니다.');
  }
  return value;
}

function cachePath() {
  return path.join(ensureHome(), 'cache', 'update.json');
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(value) {
  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {
    // A read-only home directory must never prevent the CLI from starting.
  }
}

function versionParts(version) {
  return String(version || '')
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function isNewerVersion(latest, installed = VERSION) {
  const next = versionParts(latest);
  const current = versionParts(installed);
  const length = Math.max(next.length, current.length);
  for (let index = 0; index < length; index += 1) {
    if (next[index] === current[index]) continue;
    return next[index] > current[index];
  }
  return false;
}

function updateInfo(latestVersion) {
  if (!latestVersion || !isNewerVersion(latestVersion)) return null;
  return {
    currentVersion: VERSION,
    latestVersion,
    installCommand: 'cheapai --update',
  };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(message);
        error.code = 'update_timeout';
        reject(error);
      }, ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function fetchLatestVersion({
  fetchImpl = globalThis.fetch,
  timeoutMs = UPDATE_REQUEST_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  const work = (async () => {
    const response = await fetchImpl(REGISTRY_URL, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`update registry returned ${response.status}`);
    const data = await response.json();
    const latest = data?.['dist-tags']?.latest || data?.version || null;
    return latest ? safePackageVersion(latest) : null;
  })();
  try {
    return await withTimeout(work, timeoutMs, 'update check timed out');
  } catch (error) {
    controller.abort();
    work.catch(() => {});
    throw error;
  }
}

async function latestVersion({
  force = false,
  fetchImpl = globalThis.fetch,
  timeoutMs = UPDATE_REQUEST_TIMEOUT_MS,
} = {}) {
  const cached = readCache();
  const cachedVersion = cached?.latestVersion || null;
  const cacheAge = Date.now() - Number(cached?.checkedAt || 0);
  if (!force && cachedVersion && cacheAge >= 0 && cacheAge < CACHE_TTL_MS) {
    return { latestVersion: cachedVersion, source: 'cache' };
  }

  try {
    const latest = await fetchLatestVersion({ fetchImpl, timeoutMs });
    if (!latest) throw new Error('update registry returned no version');
    writeCache({ checkedAt: Date.now(), latestVersion: latest });
    return { latestVersion: latest, source: 'registry' };
  } catch (error) {
    if (cachedVersion) return { latestVersion: cachedVersion, source: 'stale-cache', error };
    throw error;
  }
}

/**
 * Lightweight startup notification. Failures are ignored so an unavailable
 * registry cannot block the TUI. Callers should not await this on the boot path.
 */
export async function checkForUpdate(options = {}) {
  if (process.env.CHEAPAI_NO_UPDATE_CHECK === '1') return null;
  try {
    const info = await latestVersion(options);
    return updateInfo(info.latestVersion);
  } catch {
    return null;
  }
}

export function npmInstallArgs(latestVersion) {
  return [
    'install',
    '--global',
    `${PACKAGE_NAME}@${safePackageVersion(latestVersion)}`,
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
  ];
}

/**
 * Resolve npm next to this Node binary. Bare `npm.cmd` via cmd.exe searches
 * the current directory first, so a leftover `~/npm.cmd` or
 * `~/node_modules/npm` breaks `cheapai --update` from the user home.
 */
export function resolveNpmInvocation({
  platform = process.platform,
  execPath = process.execPath,
  existsSync = fs.existsSync,
} = {}) {
  const nodeDir = path.dirname(execPath);
  const cliCandidates = platform === 'win32'
    ? [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [
      path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];
  for (const cli of cliCandidates) {
    if (existsSync(cli)) {
      return { command: execPath, argsPrefix: [cli], cwd: nodeDir };
    }
  }
  const npmBin = path.join(nodeDir, platform === 'win32' ? 'npm.cmd' : 'npm');
  if (existsSync(npmBin)) {
    return { command: npmBin, argsPrefix: [], cwd: nodeDir };
  }
  const error = new Error(
    'Cannot find npm next to this Node.js install. Use the Node.js installer npm, not a leftover npm.cmd in your home folder. Then run: npm install -g @akitect/cheapai@latest',
  );
  error.code = 'npm_not_found';
  throw error;
}

function runNpmInstall(args) {
  const invocation = resolveNpmInvocation();
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.argsPrefix, ...args], {
      stdio: 'inherit',
      windowsHide: true,
      cwd: invocation.cwd,
      shell: false,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, INSTALL_TIMEOUT_MS);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('Update timed out. Check the network connection and try again.'));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Update command failed (code ${code ?? 'unknown'}${signal ? `, signal ${signal}` : ''}).`));
      }
    });
  });
}

/**
 * Installs the latest published version. Separate from checkForUpdate: the
 * startup check is read-only; this runs only for `cheapai --update` or `/update`.
 */
export async function installLatestVersion({
  fetchImpl = globalThis.fetch,
  runInstall = runNpmInstall,
  timeoutMs = UPDATE_REQUEST_TIMEOUT_MS,
} = {}) {
  let result;
  try {
    result = await latestVersion({ force: true, fetchImpl, timeoutMs });
  } catch (error) {
    throw new Error(`업데이트 정보를 확인하지 못했습니다: ${error.message || error}`);
  }

  if (!isNewerVersion(result.latestVersion)) {
    return {
      updated: false,
      currentVersion: VERSION,
      latestVersion: result.latestVersion || VERSION,
      message: `이미 최신 버전입니다 (${VERSION}).`,
    };
  }

  await runInstall(npmInstallArgs(result.latestVersion));

  return {
    updated: true,
    currentVersion: VERSION,
    latestVersion: result.latestVersion,
    message: `업데이트를 완료했습니다: ${VERSION} → ${result.latestVersion}. 새 터미널에서 cheapai를 다시 실행하세요.`,
  };
}

export function formatUpdateNotice(info) {
  if (!info) return '';
  return `업데이트 있음: ${info.currentVersion} → ${info.latestVersion} · /update 또는 ${info.installCommand}`;
}
