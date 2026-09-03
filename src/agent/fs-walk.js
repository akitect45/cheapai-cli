import fs from 'node:fs';
import path from 'node:path';

export const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  'target',
  '.cargo-target',
  '__pycache__',
  '.venv',
  'venv',
  '.turbo',
  '.cache',
  '.output',
  '.svelte-kit',
  '.gradle',
]);

export function shouldSkipDir(name) {
  return SKIP_DIR_NAMES.has(String(name || ''));
}

export function matchGlob(rel, pattern) {
  const norm = String(rel || '').replace(/\\/g, '/');
  const pat = String(pattern || '').replace(/\\/g, '/');
  if (pat === '**/*' || pat === '**' || pat === '*' || pat === '*.*') return true;
  const esc = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DS::')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/::DS::/g, '.*');
  const re = new RegExp(`^${esc}$`, 'i');
  if (re.test(norm)) return true;
  if (!pat.includes('/')) {
    const base = norm.split('/').pop() || norm;
    const reBase = new RegExp(
      `^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
      'i',
    );
    return reBase.test(base);
  }
  return false;
}

export function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function walkFiles({
  base,
  pattern = null,
  maxResults = 200,
  signal = null,
  resolveSafe = (value) => value,
  throwIfAborted = () => {},
  yieldToEventLoop = null,
} = {}) {
  throwIfAborted(signal);
  const results = [];
  const root = path.resolve(base);
  const stack = [root];
  let scanned = 0;
  while (stack.length && results.length < maxResults) {
    throwIfAborted(signal);
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (results.length >= maxResults) break;
      if (ent.isDirectory() && shouldSkipDir(ent.name)) continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (ent.isDirectory() && !ent.isSymbolicLink()) {
        stack.push(full);
        continue;
      }
      let safeFull;
      try {
        safeFull = resolveSafe(full);
        const st = await fs.promises.stat(safeFull);
        if (st.isDirectory()) continue;
      } catch {
        continue;
      }
      if (!pattern || matchGlob(rel, pattern) || matchGlob(ent.name, pattern)) {
        results.push(safeFull);
      }
      scanned += 1;
      if (yieldToEventLoop && scanned % 24 === 0) {
        await yieldToEventLoop();
        throwIfAborted(signal);
      }
    }
  }
  return results;
}
