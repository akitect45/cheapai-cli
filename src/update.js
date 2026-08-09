import fs from 'node:fs';
import path from 'node:path';
import { ensureHome } from './config.js';
import { VERSION } from './ui/theme.js';

const PACKAGE_NAME = '@akitect/cheapai';
const REGISTRY_URL = 'https://registry.npmjs.org/%40akitect%2Fcheapai';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 2_500;

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
    fs.writeFileSync(cachePath(), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {
    // An update check must never affect the CLI when its cache is unavailable.
  }
}

function versionParts(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(latest, current = VERSION) {
  const next = versionParts(latest);
  const installed = versionParts(current);
  if (!next || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}

function updateInfo(latestVersion) {
  if (!isNewerVersion(latestVersion)) return null;
  return {
    currentVersion: VERSION,
    latestVersion,
    packageName: PACKAGE_NAME,
    installCommand: `npm i ${PACKAGE_NAME}`,
  };
}

async function fetchLatestVersion() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch(REGISTRY_URL, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.['dist-tags']?.latest || data?.version || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkForUpdate() {
  if (process.env.CHEAPAI_NO_UPDATE_CHECK === '1') return null;

  const cached = readCache();
  if (cached?.latestVersion && Date.now() - Number(cached.checkedAt || 0) < CACHE_TTL_MS) {
    return updateInfo(cached.latestVersion);
  }

  const latestVersion = await fetchLatestVersion();
  if (latestVersion) {
    writeCache({ checkedAt: Date.now(), latestVersion });
    return updateInfo(latestVersion);
  }

  return cached?.latestVersion ? updateInfo(cached.latestVersion) : null;
}

export function formatUpdateNotice(info) {
  if (!info) return '';
  return `업데이트 있음: ${info.currentVersion} → ${info.latestVersion} · ${info.installCommand}`;
}
