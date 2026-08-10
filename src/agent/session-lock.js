import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureHome, homeDir } from '../config.js';

const RECLAIM_GUARD_STALE_MS = 5000;

export function acquireSessionLease(sessionFile, sessionId) {
  ensureHome();
  const canonicalPath = canonicalStoragePath(sessionFile);
  const lockPath = path.join(
    homeDir(),
    'locks',
    `${crypto.createHash('sha256').update(canonicalPath).digest('hex')}.json`,
  );
  const record = {
    token: crypto.randomUUID(),
    pid: process.pid,
    processStartId: processStartIdentity(process.pid),
    sessionId,
    sessionPath: canonicalPath,
    timestamp: new Date().toISOString(),
  };

  try {
    createLeaseFile(lockPath, record);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    reclaimOrThrow(lockPath, record);
  }

  let released = false;
  return {
    ...record,
    lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (current.token === record.token) fs.unlinkSync(lockPath);
      } catch {
        /* A missing or replaced lease is not ours to remove. */
      }
    },
  };
}

export function processStartIdentity(pid, platform = process.platform) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  try {
    if (platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${numericPid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      return fields[19] ? `linux:${fields[19]}` : null;
    }
    if (platform === 'win32') {
      const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${numericPid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 2000 });
      const value = result.status === 0 ? result.stdout.trim() : '';
      return value ? `win32:${value}` : null;
    }
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(numericPid)], {
      encoding: 'utf8',
      timeout: 2000,
    });
    const value = result.status === 0 ? result.stdout.trim().replace(/\s+/g, ' ') : '';
    return value ? `${platform}:${value}` : null;
  } catch {
    return null;
  }
}

export function isLeaseOwnerAlive(record) {
  if (!record?.pid || !record?.processStartId) return true;
  try {
    process.kill(Number(record.pid), 0);
  } catch (error) {
    return error.code === 'EPERM';
  }
  const currentIdentity = processStartIdentity(record.pid);
  return currentIdentity === null || currentIdentity === record.processStartId;
}

export function verifySessionLease(lease) {
  if (!lease?.lockPath || !lease?.token) {
    const error = new Error('Missing session lease.');
    error.code = 'session_lease_lost';
    throw error;
  }
  const current = readLease(lease.lockPath);
  if (!current || current.token !== lease.token || current.sessionId !== lease.sessionId) {
    const error = new Error('Session lease was lost to another process.');
    error.code = 'session_lease_lost';
    throw error;
  }
  return true;
}

function reclaimOrThrow(lockPath, record) {
  const existing = readLease(lockPath);
  if (existing && isLeaseOwnerAlive(existing)) throw activeSessionError(existing);

  const guardPath = `${lockPath}.reclaim`;
  acquireReclaimGuard(guardPath, record);

  try {
    const current = readLease(lockPath);
    if (current && existing?.token !== current.token) throw activeSessionError(current);
    if (current && isLeaseOwnerAlive(current)) throw activeSessionError(current);
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    createLeaseFile(lockPath, record);
  } finally {
    try {
      fs.unlinkSync(guardPath);
    } catch {
      /* Best effort. */
    }
  }
}

function acquireReclaimGuard(guardPath, record) {
  try {
    createLeaseFile(guardPath, record);
    return;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const owner = readLease(guardPath);
  if (owner && isLeaseOwnerAlive(owner)) throw activeSessionError(owner);
  if (!owner) {
    try {
      if (Date.now() - fs.statSync(guardPath).mtimeMs < RECLAIM_GUARD_STALE_MS) {
        throw activeSessionError(null);
      }
    } catch (error) {
      if (error.code === 'session_already_active') throw error;
    }
  }
  try {
    fs.unlinkSync(guardPath);
    createLeaseFile(guardPath, record);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EEXIST') throw activeSessionError(owner);
    throw error;
  }
}

function createLeaseFile(lockPath, record) {
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readLease(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function activeSessionError(record) {
  const error = new Error(`Session is already active${record?.pid ? ` in process ${record.pid}` : ''}.`);
  error.code = 'session_already_active';
  error.owner = record || null;
  return error;
}

function canonicalStoragePath(filePath) {
  const resolved = path.resolve(filePath);
  const directory = path.dirname(resolved);
  let canonicalDirectory = directory;
  try {
    canonicalDirectory = fs.realpathSync.native(directory);
  } catch {
    /* The storage directory will be created by ensureHome. */
  }
  return path.join(canonicalDirectory, path.basename(resolved));
}
