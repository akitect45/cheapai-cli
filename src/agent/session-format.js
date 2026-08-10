import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SESSION_FORMAT_VERSION = 2;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_LOG_ENTRIES = 64;

export function assertSessionId(id) {
  const value = String(id || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    const error = new Error(`Invalid session id: ${value || '(empty)'}`);
    error.code = 'invalid_session_id';
    throw error;
  }
  return value;
}

export function v2SessionPath(directory, id) {
  return path.join(directory, `${assertSessionId(id)}.jsonl`);
}

export function legacySessionPath(directory, id) {
  return path.join(directory, `${assertSessionId(id)}.json`);
}

export function loadSessionLog(filePath, { repair = true } = {}) {
  const text = fs.readFileSync(filePath, 'utf8');
  const parsed = parseSessionLog(text, filePath);
  if (parsed.recoveredFinalLine && repair) {
    atomicWriteFile(filePath, `${parsed.validLines.join('\n')}\n`);
  }
  const snapshot = [...parsed.entries]
    .reverse()
    .find((entry) => entry.type === 'session_state' && entry.payload?.session);
  if (!snapshot) throw formatError(filePath, 'Session log has no session_state entry.');
  return {
    session: normalizeSession(snapshot.payload.session, parsed.header),
    header: parsed.header,
    entries: parsed.entries,
    lastEntryId: parsed.entries.at(-1)?.id || null,
    recoveredFinalLine: parsed.recoveredFinalLine,
  };
}

export function appendSessionSnapshot(filePath, session) {
  const next = normalizeSession({ ...session, storageVersion: SESSION_FORMAT_VERSION });
  if (!fs.existsSync(filePath)) {
    rewriteSessionLog(filePath, next);
    return filePath;
  }

  const current = loadSessionLog(filePath);
  const entry = createEntry('session_state', { session: next }, current.lastEntryId);
  appendDurableLine(filePath, entry);
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_LOG_BYTES || current.entries.length + 1 >= MAX_LOG_ENTRIES) {
    rewriteSessionLog(filePath, next, {
      entries: current.entries.filter((entry) => entry.type === 'custom'),
    });
  }
  return filePath;
}

export function appendSessionEntry(filePath, type, payload) {
  const current = loadSessionLog(filePath);
  const entry = createEntry(type, payload, current.lastEntryId);
  appendDurableLine(filePath, entry);
  return entry;
}

export function rewriteSessionLog(filePath, session, { entries = [] } = {}) {
  const next = normalizeSession({ ...session, storageVersion: SESSION_FORMAT_VERSION });
  const header = {
    type: 'session',
    version: SESSION_FORMAT_VERSION,
    id: assertSessionId(next.id),
    cwd: next.cwd,
    createdAt: next.createdAt,
    parentSession: next.parentId || null,
  };
  const retained = [];
  let parentId = null;
  for (const value of entries) {
    const entry = createEntry(value.type, value.payload, parentId);
    retained.push(entry);
    parentId = entry.id;
  }
  const entry = createEntry('session_state', { session: next }, parentId);
  atomicWriteFile(filePath, `${[header, ...retained, entry].map(JSON.stringify).join('\n')}\n`);
  return filePath;
}

export function migrateLegacySession(directory, session, { replace = false } = {}) {
  const id = assertSessionId(session?.id);
  const legacyPath = legacySessionPath(directory, id);
  const targetPath = v2SessionPath(directory, id);
  if (replace || !fs.existsSync(targetPath)) rewriteSessionLog(targetPath, session);
  if (fs.existsSync(legacyPath)) {
    const backupPath = `${legacyPath}.v1.bak`;
    try {
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      fs.renameSync(legacyPath, backupPath);
    } catch {
      // The valid v2 log is authoritative if cleanup cannot finish.
    }
  }
  return targetPath;
}

export function atomicWriteFile(filePath, content, { mode = 0o600 } = {}) {
  const directory = path.dirname(filePath);
  const effectiveMode = mode & ~process.umask();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', effectiveMode);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
    try {
      fs.chmodSync(filePath, effectiveMode);
      const directoryFd = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    } catch {
      /* Windows may not support directory fsync or POSIX modes. */
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      /* Best-effort cleanup; temp files are never treated as sessions. */
    }
  }
}

function parseSessionLog(text, filePath) {
  const rawLines = text.split('\n');
  const lastContentIndex = rawLines.reduce((last, line, index) => line.trim() ? index : last, -1);
  const values = [];
  const validLines = [];
  let recoveredFinalLine = false;

  for (let index = 0; index <= lastContentIndex; index++) {
    const line = rawLines[index];
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
      validLines.push(line);
    } catch (error) {
      if (index === lastContentIndex) {
        recoveredFinalLine = true;
        break;
      }
      throw formatError(filePath, `Malformed JSONL entry at line ${index + 1}: ${error.message}`);
    }
  }

  const [header, ...entries] = values;
  if (header?.type !== 'session' || header.version !== SESSION_FORMAT_VERSION) {
    throw formatError(filePath, `Unsupported session header version: ${header?.version ?? 'missing'}`);
  }
  assertSessionId(header.id);
  for (const entry of entries) {
    if (!entry?.type || !entry.id || !entry.timestamp || !Object.hasOwn(entry, 'payload')) {
      throw formatError(filePath, 'Invalid session entry envelope.');
    }
  }
  return { header, entries, validLines, recoveredFinalLine };
}

function appendDurableLine(filePath, value) {
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(fd);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* Windows may ignore POSIX modes. */
    }
  } finally {
    fs.closeSync(fd);
  }
}

function createEntry(type, payload, parentId) {
  return {
    type,
    id: crypto.randomUUID(),
    parentId: parentId || null,
    timestamp: new Date().toISOString(),
    payload,
  };
}

function normalizeSession(session, header = null) {
  const value = JSON.parse(JSON.stringify(session || {}));
  value.id = assertSessionId(value.id || header?.id);
  value.cwd = path.resolve(value.cwd || header?.cwd || process.cwd());
  value.createdAt = value.createdAt || header?.createdAt || new Date().toISOString();
  value.updatedAt = value.updatedAt || value.createdAt;
  value.parentId = value.parentId || header?.parentSession || null;
  value.messages = Array.isArray(value.messages) ? value.messages : [];
  return value;
}

function formatError(filePath, message) {
  const error = new Error(`${message} (${filePath})`);
  error.code = 'invalid_session_format';
  return error;
}
