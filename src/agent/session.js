import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureHome, homeDir } from '../config.js';

export function sessionsDir() {
  ensureHome();
  return path.join(homeDir(), 'sessions');
}

export function newSessionId() {
  return crypto.randomUUID();
}

export function sessionPath(id) {
  return path.join(sessionsDir(), `${id}.json`);
}

export function saveSession(session) {
  ensureHome();
  const p = sessionPath(session.id);
  fs.writeFileSync(
    p,
    JSON.stringify(
      {
        ...session,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
  // index by cwd
  const idxPath = path.join(sessionsDir(), 'index.jsonl');
  fs.appendFileSync(
    idxPath,
    JSON.stringify({
      id: session.id,
      cwd: session.cwd,
      updatedAt: new Date().toISOString(),
      title: session.title || '',
    }) + '\n',
    'utf8',
  );
  return p;
}

export function loadSession(id) {
  const p = sessionPath(id);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  const matches = listAllSessions().filter((session) => session.id.startsWith(String(id || '')));
  return matches.length === 1 ? matches[0] : null;
}

export function findLatestSession(cwd) {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return null;
  const target = comparableWorkspace(cwd);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'index.jsonl')
    .map((f) => {
      const full = path.join(dir, f);
      try {
        const data = JSON.parse(fs.readFileSync(full, 'utf8'));
        return { data, mtime: fs.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((x) => comparableWorkspace(x.data.cwd || '') === target)
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.data || null;
}

export function listSessions(cwd) {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  const target = comparableWorkspace(cwd);
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json') && file !== 'index.jsonl')
    .map((file) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((session) => session && comparableWorkspace(session.cwd || '') === target)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

export function listAllSessions() {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json') && file !== 'index.jsonl')
    .map((file) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

export function deleteSession(id) {
  const session = loadSession(id);
  if (!session) return false;
  const target = sessionPath(session.id);
  if (!fs.existsSync(target)) return false;
  fs.unlinkSync(target);
  return true;
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

export function comparableWorkspace(cwd, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const resolved = pathApi.normalize(pathApi.resolve(cwd));
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}
