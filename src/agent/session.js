import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureHome, homeDir } from '../config.js';
import {
  appendSessionEntry as appendLogEntry,
  appendSessionSnapshot,
  assertSessionId,
  atomicWriteFile,
  legacySessionPath,
  loadSessionLog,
  migrateLegacySession,
  v2SessionPath,
} from './session-format.js';
import { acquireSessionLease, verifySessionLease } from './session-lock.js';

const SESSION_LEASES = new WeakMap();

export function sessionsDir() {
  ensureHome();
  return path.join(homeDir(), 'sessions');
}

export function newSessionId() {
  return crypto.randomUUID();
}

export function sessionPath(id) {
  return v2SessionPath(sessionsDir(), id);
}

export function saveSession(session) {
  ensureHome();
  assertSessionId(session?.id);
  const boundLease = SESSION_LEASES.get(session);
  const temporaryLease = boundLease ? null : acquireSession(session.id);
  if (boundLease) verifySessionLease(boundLease);
  session.updatedAt = new Date().toISOString();
  session.storageVersion = 2;
  const p = sessionPath(session.id);
  try {
    const oldPath = legacySessionPath(sessionsDir(), session.id);
    if (fs.existsSync(oldPath) && fs.existsSync(p) && fs.statSync(oldPath).mtimeMs > fs.statSync(p).mtimeMs) {
      const error = new Error('A newer legacy session writer was detected; refusing to overwrite it.');
      error.code = 'session_format_conflict';
      throw error;
    }
    appendSessionSnapshot(p, session);
    rebuildSessionIndex();
    return p;
  } finally {
    temporaryLease?.release();
  }
}

export function loadSession(id) {
  const candidate = String(id || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(candidate)) return null;
  const exact = loadStoredSession(candidate);
  if (exact) return exact;
  const matches = listAllSessions().filter((session) => session.id.startsWith(candidate));
  return matches.length === 1 ? loadStoredSession(matches[0].id) : null;
}

export function findLatestSession(cwd) {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return null;
  const target = comparableWorkspace(cwd);
  const files = fs
    .readdirSync(dir)
    .filter(isSessionFilename)
    .map((file) => {
      const id = sessionIdFromFilename(file);
      try {
        const data = loadStoredSession(id);
        return data ? { data, mtime: storedSessionMtime(dir, id) } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((item, index, items) => items.findIndex((candidate) => candidate.data.id === item.data.id) === index)
    .filter((x) => comparableWorkspace(x.data.cwd || '') === target)
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.data || null;
}

export function listSessions(cwd) {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  const target = comparableWorkspace(cwd);
  return storedSessionIds(dir)
    .map((id) => loadStoredSession(id, { readOnly: true }))
    .filter((session) => session && comparableWorkspace(session.cwd || '') === target)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

export function listAllSessions() {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  return storedSessionIds(dir)
    .map((id) => loadStoredSession(id, { readOnly: true }))
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

export function deleteSession(id) {
  const session = loadSession(id);
  if (!session) return false;
  const lease = acquireSession(session.id);
  try {
    const targets = [
      sessionPath(session.id),
      legacySessionPath(sessionsDir(), session.id),
      `${legacySessionPath(sessionsDir(), session.id)}.v1.bak`,
    ];
    let deleted = false;
    for (const target of targets) {
      if (!fs.existsSync(target)) continue;
      fs.unlinkSync(target);
      deleted = true;
    }
    if (deleted) rebuildSessionIndex();
    return deleted;
  } finally {
    lease.release();
  }
}

export function acquireSession(id) {
  const sessionId = assertSessionId(id);
  return acquireSessionLease(sessionPath(sessionId), sessionId);
}

export function bindSessionLease(session, lease) {
  if (!session || session.id !== lease?.sessionId) throw new Error('Session lease does not match the session.');
  verifySessionLease(lease);
  SESSION_LEASES.set(session, lease);
  return session;
}

export function releaseSessionLease(session) {
  const lease = SESSION_LEASES.get(session);
  SESSION_LEASES.delete(session);
  lease?.release();
}

export function transferSessionLease(previousSession, nextSession) {
  const lease = SESSION_LEASES.get(previousSession);
  if (!lease || previousSession?.id !== nextSession?.id) {
    const error = new Error('Session lease transfer requires two objects for the same active session.');
    error.code = 'invalid_session_lease_transfer';
    throw error;
  }
  verifySessionLease(lease);
  SESSION_LEASES.delete(previousSession);
  SESSION_LEASES.set(nextSession, lease);
  return lease;
}

export function appendSessionEntry(sessionOrId, type, payload) {
  const session = typeof sessionOrId === 'object' ? sessionOrId : null;
  const id = assertSessionId(session?.id || sessionOrId);
  const boundLease = session ? SESSION_LEASES.get(session) : null;
  const temporaryLease = boundLease ? null : acquireSession(id);
  if (boundLease) verifySessionLease(boundLease);
  try {
    return appendLogEntry(sessionPath(id), type, payload);
  } finally {
    temporaryLease?.release();
  }
}

export function rebuildSessionIndex() {
  const indexPath = path.join(sessionsDir(), 'index.jsonl');
  const lines = listAllSessions().map((session) => JSON.stringify({
    id: session.id,
    cwd: session.cwd,
    updatedAt: session.updatedAt,
    title: session.title || '',
  }));
  atomicWriteFile(indexPath, lines.length ? `${lines.join('\n')}\n` : '');
  return indexPath;
}

export function forkSession(source, { title } = {}) {
  const now = new Date().toISOString();
  const fork = {
    ...JSON.parse(JSON.stringify(source)),
    id: newSessionId(),
    parentId: source.id,
    title: String(title || `${source.title || 'Untitled session'} (fork)`).slice(0, 80),
    createdAt: now,
    updatedAt: now,
    undoStack: [],
    redoStack: [],
  };
  saveSession(fork);
  return fork;
}

export function exportSessionData(session, { sanitize = false } = {}) {
  const data = JSON.parse(JSON.stringify(session));
  if (sanitize) {
    delete data.undoStack;
    delete data.redoStack;
    data.messages = (data.messages || []).map((message) => {
      if (message.role !== 'tool') return message;
      return {
        ...message,
        content: '[tool output redacted]',
        tool_calls: undefined,
      };
    });
    data.messages = data.messages.map((message) => {
      if (message.role !== 'assistant' || !message.tool_calls) return message;
      return {
        ...message,
        tool_calls: message.tool_calls.map((call) => ({
          ...call,
          function: { ...call.function, arguments: '[arguments redacted]' },
        })),
      };
    });
  }
  return { object: 'cheapai.session', version: 1, session: data };
}

export function importSessionData(value, { cwd } = {}) {
  const source = value?.object === 'cheapai.session' ? value.session : value?.session || value;
  if (!source || !Array.isArray(source.messages)) throw new Error('Invalid CheapAI session export.');
  const now = new Date().toISOString();
  const session = {
    ...JSON.parse(JSON.stringify(source)),
    id: newSessionId(),
    parentId: source.id || source.parentId || null,
    cwd: path.resolve(cwd || source.cwd || process.cwd()),
    createdAt: now,
    updatedAt: now,
    title: String(source.title || 'Imported session').slice(0, 80),
    undoStack: [],
    redoStack: [],
  };
  saveSession(session);
  return session;
}

export function sessionStats(sessions = listAllSessions()) {
  const totals = {
    sessions: sessions.length,
    messages: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    credits: 0,
    compactions: 0,
    models: {},
    tools: {},
  };
  for (const session of sessions) {
    totals.messages += session.messages?.filter((message) => message.role !== 'system').length || 0;
    totals.inputTokens += Number(session.usage?.inputTokens) || 0;
    totals.outputTokens += Number(session.usage?.outputTokens) || 0;
    totals.totalTokens += Number(session.usage?.totalTokens) || 0;
    totals.credits += Number(session.usage?.credits) || 0;
    totals.compactions += session.compactions?.length || 0;
    const model = session.model || 'unknown';
    totals.models[model] = (totals.models[model] || 0) + 1;
    for (const message of session.messages || []) {
      for (const call of message.tool_calls || []) {
        const name = call?.function?.name || 'unknown';
        totals.tools[name] = (totals.tools[name] || 0) + 1;
      }
    }
  }
  totals.credits = Math.round(totals.credits * 100) / 100;
  return totals;
}

export function createSession({ cwd, model, systemPrompt }) {
  return {
    id: newSessionId(),
    cwd: path.resolve(cwd),
    model,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: '',
    agent: 'build',
    usage: {},
    contextWindow: null,
    compactions: [],
    messages: [{ role: 'system', content: systemPrompt }],
  };
}

function loadStoredSession(id, { readOnly = false } = {}) {
  let sessionId;
  try {
    sessionId = assertSessionId(id);
  } catch {
    return null;
  }
  const directory = sessionsDir();
  const currentPath = v2SessionPath(directory, sessionId);
  if (fs.existsSync(currentPath)) {
    try {
      const legacyPath = legacySessionPath(directory, sessionId);
      const legacyIsNewer = fs.existsSync(legacyPath)
        && fs.statSync(legacyPath).mtimeMs > fs.statSync(currentPath).mtimeMs;
      if (legacyIsNewer) {
        const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        if (readOnly) return legacy?.id === sessionId ? legacy : null;
        const lease = acquireSession(sessionId);
        try {
          migrateLegacySession(directory, legacy, { replace: true });
        } finally {
          lease.release();
        }
      }
      const parsed = loadSessionLog(currentPath, { repair: false });
      if (!parsed.recoveredFinalLine || readOnly) return parsed.session;
      const lease = acquireSession(sessionId);
      try {
        return loadSessionLog(currentPath, { repair: true }).session;
      } finally {
        lease.release();
      }
    } catch {
      return null;
    }
  }

  const oldPath = legacySessionPath(directory, sessionId);
  if (!fs.existsSync(oldPath)) return null;
  try {
    const legacy = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
    if (legacy?.id !== sessionId) return null;
    if (readOnly) return legacy;
    const lease = acquireSession(sessionId);
    try {
      migrateLegacySession(directory, legacy);
      return loadSessionLog(currentPath, { repair: false }).session;
    } finally {
      lease.release();
    }
  } catch {
    return null;
  }
}

function storedSessionIds(directory) {
  return [...new Set(fs.readdirSync(directory)
    .filter(isSessionFilename)
    .map(sessionIdFromFilename)
    .filter(Boolean))];
}

function storedSessionMtime(directory, id) {
  return Math.max(...[v2SessionPath(directory, id), legacySessionPath(directory, id)]
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.statSync(file).mtimeMs));
}

function isSessionFilename(file) {
  if (file === 'index.jsonl') return false;
  return file.endsWith('.jsonl') || file.endsWith('.json');
}

function sessionIdFromFilename(file) {
  const extension = file.endsWith('.jsonl') ? '.jsonl' : file.endsWith('.json') ? '.json' : '';
  if (!extension) return null;
  const id = file.slice(0, -extension.length);
  try {
    return assertSessionId(id);
  } catch {
    return null;
  }
}

export function comparableWorkspace(cwd, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const resolved = pathApi.normalize(pathApi.resolve(cwd));
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}
