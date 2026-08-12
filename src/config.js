import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_BASE_URL = 'https://api.cheapai.im/v1';
export const DEFAULT_WEB_ORIGIN = 'https://cheapai.im';
export const DEFAULT_MODEL = 'claude-sonnet-5';
/** Device-code endpoints on the web origin (server-side, in progress) */
export const DEVICE_CODE_PATH = '/api/auth/device/code';
export const DEVICE_POLL_PATH = '/api/auth/device/poll';
const PROJECT_CONFIG_KEYS = new Set([
  'model',
  'maxTurns',
  'temperature',
  'reasoningEffort',
  'showThinking',
  'autoCompact',
  'compactThreshold',
]);

export function homeDir() {
  return process.env.CHEAPAI_HOME || path.join(os.homedir(), '.cheapai');
}

export function ensureHome() {
  const dir = homeDir();
  for (const sub of ['', 'sessions', 'cache', 'locks', 'recovery']) {
    const p = sub ? path.join(dir, sub) : dir;
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(p, 0o700);
    } catch {
      /* Windows may ignore POSIX modes. */
    }
  }
  return dir;
}

export function authPath() {
  return path.join(homeDir(), 'auth.json');
}

export function configPath() {
  return path.join(homeDir(), 'config.json');
}

export function loadAuth() {
  ensureHome();
  const p = authPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function saveAuth(auth) {
  ensureHome();
  const p = authPath();
  fs.writeFileSync(p, JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* windows may ignore */
  }
}

export function clearAuth() {
  const p = authPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function loadConfig() {
  ensureHome();
  const p = configPath();
  const defaults = {
    baseUrl: DEFAULT_BASE_URL,
    webOrigin: DEFAULT_WEB_ORIGIN,
    model: DEFAULT_MODEL,
    permissionMode: 'ask',
    maxTurns: 0,
    temperature: 0.2,
    reasoningEffort: 'off',
    showThinking: true,
    showBalance: false,
    autoCompact: true,
    compactThreshold: 0.8,
    pathMode: 'workspace',
    extraRoots: [],
    approvedExtensions: [],
  };
  if (!fs.existsSync(p)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch {
    return defaults;
  }
}

export function loadScopedConfig(cwd = process.cwd()) {
  const base = loadConfig();
  const roots = [];
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  while (true) {
    roots.push(path.join(dir, '.cheapai', 'config.json'));
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const projectConfig = roots.reverse().reduce((result, filePath) => {
    if (!fs.existsSync(filePath)) return result;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const allowed = Object.fromEntries(Object.entries(parsed).filter(([key]) => PROJECT_CONFIG_KEYS.has(key)));
      return { ...result, ...allowed };
    } catch {
      return result;
    }
  }, {});
  return { ...base, ...projectConfig };
}

export function saveConfig(cfg) {
  ensureHome();
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(configPath(), 0o600);
  } catch {
    /* Windows may ignore POSIX modes. */
  }
}

export function resolveApiKey(auth = loadAuth()) {
  return (
    process.env.CHEAPAI_API_KEY ||
    process.env.CHEAPSUB_API_KEY ||
    auth?.apiKey ||
    null
  );
}

export function resolveBaseUrl(cfg = loadConfig(), auth = loadAuth()) {
  return (
    process.env.CHEAPAI_BASE_URL ||
    auth?.baseUrl ||
    cfg.baseUrl ||
    DEFAULT_BASE_URL
  ).replace(/\/$/, '');
}

export function resolveModel(cliModel, cfg = loadConfig()) {
  return cliModel || process.env.CHEAPAI_MODEL || cfg.model || DEFAULT_MODEL;
}

/** Find project instruction files walking up from cwd */
export function findProjectInstructions(cwd = process.cwd()) {
  const names = ['CHEAPAI.md', 'AGENTS.md', 'CLAUDE.md'];
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  const chunks = [];
  while (true) {
    for (const name of names) {
      const fp = path.join(dir, name);
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        try {
          const text = fs.readFileSync(fp, 'utf8').slice(0, 80_000);
          chunks.push({ path: fp, text });
        } catch {
          /* skip */
        }
      }
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chunks;
}
