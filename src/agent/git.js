import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { safeChildEnvironment } from './process-runner.js';

const MAX_DIFF = 200_000;
const MAX_MESSAGE = 4_000;
const READ_ACTIONS = new Set(['status', 'diff', 'log', 'branch', 'branches']);
export const GIT_MUTATING_ACTIONS = new Set([
  'stage',
  'unstage',
  'commit',
  'discard',
  'checkout',
  'push',
  'pull',
  'force-push',
  'force_push',
]);

export function isGitMutating(action) {
  return GIT_MUTATING_ACTIONS.has(String(action || 'status'));
}

export async function runGitTool({ cwd, args = {}, resolvePath, signal } = {}) {
  const resolved = path.resolve(cwd || process.cwd());
  let root = resolved;
  try {
    root = fs.realpathSync.native(resolved);
  } catch {
    root = resolved;
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { error: 'Workspace folder is missing.' };
  }
  const action = String(args.action || 'status');
  try {
    return await runInner(root, action, args, { resolvePath, signal });
  } catch (error) {
    const message = String(error?.message || error);
    if (/not a git repository/i.test(message) && READ_ACTIONS.has(action === 'branches' ? 'branch' : action)) {
      return { repo: false, error: message, files: [], commits: [], branches: [] };
    }
    return { error: message };
  }
}

async function runInner(cwd, action, args, ctx) {
  switch (action) {
    case 'status':
      return status(cwd, ctx);
    case 'diff':
      return diff(cwd, args, ctx);
    case 'log':
      return log(cwd, args, ctx);
    case 'stage':
      return stage(cwd, args, true, ctx);
    case 'unstage':
      return stage(cwd, args, false, ctx);
    case 'commit':
      return commit(cwd, args, ctx);
    case 'discard':
      return discard(cwd, args, ctx);
    case 'branch':
    case 'branches':
      return branches(cwd, ctx);
    case 'checkout':
      return checkout(cwd, args, ctx);
    case 'push':
      return push(cwd, args, false, ctx);
    case 'force-push':
    case 'force_push':
      return push(cwd, args, true, ctx);
    case 'pull':
      return pull(cwd, args, ctx);
    default:
      throw new Error(`Unknown git action: ${action}`);
  }
}

async function status(cwd, ctx) {
  const output = await git(cwd, ['status', '--porcelain=v1', '-b', '--untracked-files=all'], ctx);
  let branch = 'HEAD';
  let ahead = 0;
  let behind = 0;
  let detached = false;
  const files = [];

  for (const [index, line] of output.split('\n').entries()) {
    if (index === 0 && line.startsWith('## ')) {
      const rest = line.slice(3);
      detached = rest.includes('HEAD (no branch)') || rest.startsWith('HEAD');
      if (rest.includes('...')) {
        const [local, extra = ''] = rest.split('...');
        branch = local.trim() || 'HEAD';
        const start = extra.indexOf('[');
        if (start >= 0) {
          const meta = extra.slice(start).replace(/^[\[\s]+|[\]\s]+$/g, '');
          for (const part of meta.split(',')) {
            const item = part.trim();
            if (item.startsWith('ahead ')) ahead = Number(item.slice(6)) || 0;
            if (item.startsWith('behind ')) behind = Number(item.slice(7)) || 0;
          }
        }
      } else if (rest.includes('No commits yet')) {
        const name = rest.split(' on ')[1]?.trim();
        branch = name || 'main';
      } else {
        branch = rest.split(/\s+/)[0] || 'HEAD';
      }
      continue;
    }
    if (line.length < 3) continue;
    const indexStatus = line[0];
    const workStatus = line[1];
    let pathPart = line.slice(2);
    if (pathPart.startsWith(' ')) pathPart = pathPart.slice(1);
    const [from, to] = pathPart.includes(' -> ') ? pathPart.split(' -> ') : [pathPart, null];
    const filePath = (to || from).replace(/\\/g, '/');
    if (!filePath) continue;
    files.push({
      path: filePath,
      orig: to ? from.replace(/\\/g, '/') : undefined,
      index: indexStatus,
      worktree: workStatus,
      staged: indexStatus !== ' ' && indexStatus !== '?',
      unstaged: workStatus !== ' ' || indexStatus === '?',
      untracked: indexStatus === '?' && workStatus === '?',
      status: displayStatus(indexStatus, workStatus),
    });
  }

  let commits = [];
  try {
    commits = (await log(cwd, { limit: 18 }, ctx)).commits || [];
  } catch {
    commits = [];
  }
  return { repo: true, branch, detached, ahead, behind, files, commits };
}

function displayStatus(index, worktree) {
  if (index === '?' && worktree === '?') return 'U';
  if (index !== ' ' && index !== '?') return index;
  if (worktree !== ' ') return worktree;
  return index;
}

async function diff(cwd, args, ctx) {
  const staged = !!args.staged;
  const filePath = String(args.path || '').trim();
  const argv = ['diff', '--no-color', '--find-renames'];
  if (staged) argv.push('--cached');
  if (filePath) {
    argv.push('--', safeRel(cwd, filePath, ctx));
  }
  const text = truncate(await git(cwd, argv, ctx), MAX_DIFF);
  return { staged, path: filePath, diff: text };
}

async function log(cwd, args, ctx) {
  const limit = clamp(Number(args.limit) || 20, 1, 50);
  let output;
  try {
    output = await git(cwd, [
      'log',
      `-${limit}`,
      '--pretty=format:%H%x09%h%x09%an%x09%ad%x09%s',
      '--date=iso-strict',
    ], ctx);
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('does not have any commits') || message.includes('bad default revision')) {
      return { commits: [] };
    }
    throw error;
  }
  const commits = output.split('\n').filter(Boolean).map((line) => {
    const [hash = '', short = '', author = '', date = '', subject = ''] = line.split('\t');
    return { hash, short, author, date, subject };
  });
  return { commits };
}

async function stage(cwd, args, add, ctx) {
  const paths = pathsFrom(args);
  if (!paths.length) throw new Error('paths is required');
  const rels = paths.map((item) => safeRel(cwd, item, ctx));
  await git(cwd, [add ? 'add' : 'restore', ...(add ? [] : ['--staged']), '--', ...rels], ctx);
  return status(cwd, ctx);
}

async function commit(cwd, args, ctx) {
  const message = String(args.message || '').trim();
  if (!message) throw new Error('Commit message is required.');
  if (message.length > MAX_MESSAGE) throw new Error('Commit message is too long.');
  const paths = pathsFrom(args);
  if (paths.length) {
    await git(cwd, ['add', '--', ...paths.map((item) => safeRel(cwd, item, ctx))], ctx);
  }
  await git(cwd, ['commit', '-m', message], ctx);
  return status(cwd, ctx);
}

async function discard(cwd, args, ctx) {
  const paths = pathsFrom(args);
  if (!paths.length) throw new Error('paths is required');
  const rels = paths.map((item) => safeRel(cwd, item, ctx));
  const tracked = [];
  const untracked = [];
  for (const rel of rels) {
    const listed = await git(cwd, ['ls-files', '--', rel], ctx).catch(() => '');
    const full = path.join(cwd, rel);
    if (!listed.trim() && (fs.existsSync(full))) untracked.push(rel);
    else tracked.push(rel);
  }
  if (tracked.length) {
    await git(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked], ctx);
  }
  if (untracked.length) {
    await git(cwd, ['clean', '-f', '-d', '--', ...untracked], ctx);
  }
  return status(cwd, ctx);
}

async function branches(cwd, ctx) {
  const output = await git(cwd, ['branch', '--list', '--no-color'], ctx);
  const list = output.split('\n').flatMap((line) => {
    const current = line.startsWith('*');
    const name = line.replace(/^\*/, '').trim();
    return name ? [{ name, current }] : [];
  });
  return { branches: list };
}

async function checkout(cwd, args, ctx) {
  const name = String(args.ref || args.branch || args.name || '').trim();
  if (!validRef(name)) throw new Error('Invalid branch name.');
  const create = !!args.create;
  try {
    await git(cwd, create ? ['switch', '-c', name] : ['switch', name], ctx);
  } catch {
    await git(cwd, create ? ['checkout', '-b', name] : ['checkout', name], ctx);
  }
  return status(cwd, ctx);
}

async function push(cwd, args, forceAction, ctx) {
  const remote = String(args.remote || 'origin').trim();
  if (!validRef(remote)) throw new Error('Invalid remote name.');
  const branch = String(args.ref || args.branch || '').trim();
  if (branch && !validRef(branch)) throw new Error('Invalid branch name.');
  const force = forceAction || !!args.force;
  const lease = args.lease !== false;
  const argv = ['push'];
  if (force) argv.push(lease ? '--force-with-lease' : '--force');
  argv.push(remote);
  if (branch) argv.push(branch);
  const output = await git(cwd, argv, ctx);
  const next = await status(cwd, ctx);
  return { ...next, pushed: true, forced: force, output: output.trim() };
}

async function pull(cwd, args, ctx) {
  const remote = String(args.remote || 'origin').trim();
  if (!validRef(remote)) throw new Error('Invalid remote name.');
  const branch = String(args.ref || args.branch || '').trim();
  if (branch && !validRef(branch)) throw new Error('Invalid branch name.');
  const argv = ['pull', args.rebase ? '--rebase' : '--ff-only', remote];
  if (branch) argv.push(branch);
  const output = await git(cwd, argv, ctx);
  const next = await status(cwd, ctx);
  return { ...next, pulled: true, output: output.trim() };
}

function git(cwd, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], {
      cwd,
      env: safeChildEnvironment(process.env),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = { stdout: [], stderr: [] };
    const finish = (error, stdout) => {
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(stdout);
    };
    const onAbort = () => {
      child.kill('SIGTERM');
      finish(Object.assign(new Error('git aborted'), { code: 'aborted' }));
    };
    child.stdout.on('data', (chunk) => chunks.stdout.push(chunk));
    child.stderr.on('data', (chunk) => chunks.stderr.push(chunk));
    child.once('error', (error) => {
      finish(error.code === 'ENOENT'
        ? new Error('Git is not installed or not on PATH.')
        : error);
    });
    child.once('close', (code) => {
      const stdout = Buffer.concat(chunks.stdout).toString('utf8');
      const stderr = Buffer.concat(chunks.stderr).toString('utf8').trim();
      if (code === 0) {
        finish(null, stdout);
        return;
      }
      const combined = stderr || stdout.trim();
      if (/not a git repository/i.test(combined)) {
        finish(new Error('Not a git repository.'));
        return;
      }
      finish(new Error(combined || `git ${args[0] || 'command'} failed`));
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function pathsFrom(args) {
  if (Array.isArray(args.paths)) {
    return args.paths.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 400);
  }
  const single = String(args.path || '').trim();
  return single ? [single] : [];
}

function safeRel(cwd, input, { resolvePath } = {}) {
  const trimmed = String(input || '').trim();
  if (!trimmed || trimmed.startsWith('-')) {
    throw new Error('Invalid path.');
  }
  const absolute = resolvePath
    ? resolvePath(trimmed)
    : path.resolve(path.isAbsolute(trimmed) ? trimmed : path.join(cwd, trimmed));
  const rel = path.relative(cwd, absolute).replace(/\\/g, '/');
  if (!rel || rel === '.' || rel.startsWith('..')) {
    throw new Error('Path must be a file inside the workspace.');
  }
  if (rel.split('/').includes('.git')) {
    throw new Error('Cannot target .git.');
  }
  return rel;
}

function validRef(name) {
  if (!name || name.length > 200 || name.startsWith('-') || name.includes('..')) return false;
  return /^[A-Za-z0-9._/-]+$/.test(name);
}

function truncate(text, max) {
  const value = String(text);
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… truncated …`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
