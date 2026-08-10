import fs from 'node:fs';
import path from 'node:path';

const MODES = new Set(['workspace', 'workspace-plus', 'unrestricted']);

export function createPathPolicy({ cwd = process.cwd(), mode = 'workspace', extraRoots = [] } = {}) {
  if (!MODES.has(mode)) throw new Error(`Unknown path policy mode: ${mode}`);
  const workspace = canonicalizeExisting(path.resolve(cwd));
  const roots = [workspace];
  if (mode === 'workspace-plus') {
    for (const root of extraRoots) roots.push(canonicalizeExisting(path.resolve(root)));
  }

  return {
    mode,
    workspace,
    roots,
    resolve(inputPath) {
      if (typeof inputPath !== 'string' || !inputPath.trim()) {
        const error = new Error('Path must be a non-empty string.');
        error.code = 'invalid_path';
        throw error;
      }
      const absolute = path.isAbsolute(inputPath)
        ? path.resolve(inputPath)
        : path.resolve(workspace, inputPath);
      if (mode === 'unrestricted') return absolute;
      const canonical = canonicalizeNearest(absolute);
      if (!roots.some((root) => isPathInside(canonical, root))) {
        const error = new Error(`Path escapes the authorized workspace: ${inputPath}`);
        error.code = 'path_outside_workspace';
        throw error;
      }
      return canonical;
    },
  };
}

export function isPathInside(candidate, root, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const normalize = (value) => {
    const normalized = pathApi.normalize(value);
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const relative = pathApi.relative(normalize(root), normalize(candidate));
  return relative === '' || (!relative.startsWith(`..${pathApi.sep}`) && relative !== '..' && !pathApi.isAbsolute(relative));
}

function canonicalizeExisting(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function canonicalizeNearest(value) {
  let cursor = path.resolve(value);
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const base = canonicalizeExisting(cursor);
  return path.resolve(base, ...suffix);
}
