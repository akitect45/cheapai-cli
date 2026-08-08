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
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
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

export function createSession({ cwd, model, systemPrompt }) {
  return {
    id: newSessionId(),
    cwd: path.resolve(cwd),
    model,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: '',
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
