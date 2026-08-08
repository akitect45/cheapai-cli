import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { saveSession } from './session.js';

const MAX_ENTRIES = 20;
const MAX_FILE_BYTES = 512_000;
const MAX_HISTORY_BYTES = 2_000_000;

export function beginTurn(session) {
  session.redoStack = [];
  return {
    id: crypto.randomUUID(),
    messageStart: session.messages?.length || 0,
    beforeTitle: session.title || '',
    beforeUsage: clone(session.usage || {}),
    beforeContextWindow: session.contextWindow ?? null,
    beforeContextTokens: session.lastContextTokens ?? null,
    fileChanges: [],
    bashCommands: [],
    startedAt: new Date().toISOString(),
  };
}

export function recordFileChange(checkpoint, change) {
  if (!checkpoint || !change?.path) return;
  const existing = checkpoint.fileChanges.find((item) => item.path === change.path);
  if (existing) {
    existing.after = change.after;
    existing.restorable = existing.restorable && change.restorable !== false;
    return;
  }
  checkpoint.fileChanges.push({
    path: change.path,
    before: change.before,
    after: change.after,
    restorable: change.restorable !== false,
  });
}

export function recordBash(checkpoint, command) {
  if (!checkpoint || !command) return;
  checkpoint.bashCommands.push(String(command).slice(0, 500));
}

export function finishTurn(session, checkpoint) {
  if (!checkpoint || (session.messages?.length || 0) <= checkpoint.messageStart) return;
  const entry = {
    ...checkpoint,
    afterTitle: session.title || '',
    afterUsage: clone(session.usage || {}),
    afterContextWindow: session.contextWindow ?? null,
    afterContextTokens: session.lastContextTokens ?? null,
    finishedAt: new Date().toISOString(),
  };
  session.undoStack = trimHistory([...(session.undoStack || []), entry]);
  saveSession(session);
}

export function undoTurn(session) {
  const stack = Array.isArray(session.undoStack) ? session.undoStack : [];
  const entry = stack.pop();
  if (!entry) return { ok: false, reason: 'Nothing to undo.' };

  const messages = session.messages.splice(entry.messageStart);
  const restored = restoreFiles(entry.fileChanges, 'before');
  restoreState(session, entry, 'before');
  session.redoStack = trimHistory([...(session.redoStack || []), {
    ...entry,
    messages: clone(messages),
  }]);
  session.undoStack = stack;
  saveSession(session);
  return {
    ok: true,
    messages: messages.length,
    prompt: messages.find((message) => message?.role === 'user')?.content || '',
    filesRestored: restored.restored,
    filesSkipped: restored.skipped,
    shellChanges: entry.bashCommands?.length || 0,
  };
}

export function redoTurn(session) {
  const stack = Array.isArray(session.redoStack) ? session.redoStack : [];
  const entry = stack.pop();
  if (!entry) return { ok: false, reason: 'Nothing to redo.' };

  const messageStart = session.messages.length;
  session.messages.push(...clone(entry.messages || []));
  const restored = restoreFiles(entry.fileChanges, 'after');
  restoreState(session, entry, 'after');
  session.undoStack = trimHistory([...(session.undoStack || []), { ...entry, messageStart, messages: undefined }]);
  session.redoStack = stack;
  saveSession(session);
  return {
    ok: true,
    messages: entry.messages?.length || 0,
    prompt: entry.messages?.find((message) => message?.role === 'user')?.content || '',
    filesRestored: restored.restored,
    filesSkipped: restored.skipped,
    shellChanges: entry.bashCommands?.length || 0,
  };
}

export function snapshotFile(filePath) {
  const abs = path.resolve(filePath);
  try {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return { exists: true, type: 'directory' };
    if (stat.size > MAX_FILE_BYTES) {
      return { exists: true, type: 'file', size: stat.size, restorable: false };
    }
    return {
      exists: true,
      type: 'file',
      content: fs.readFileSync(abs).toString('base64'),
      encoding: 'base64',
    };
  } catch {
    return { exists: false, type: 'file' };
  }
}

export function restoreSnapshot(filePath, snapshot) {
  if (!snapshot || snapshot.restorable === false) return false;
  const abs = path.resolve(filePath);
  if (!snapshot.exists) {
    try {
      if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) fs.unlinkSync(abs);
      return true;
    } catch {
      return false;
    }
  }
  if (snapshot.type === 'directory') return true;
  if (snapshot.restorable === false) return false;
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const content = snapshot.encoding === 'base64'
      ? Buffer.from(snapshot.content || '', 'base64')
      : snapshot.content || '';
    fs.writeFileSync(abs, content);
    return true;
  } catch {
    return false;
  }
}

function restoreFiles(changes = [], side) {
  let restored = 0;
  let skipped = 0;
  const list = side === 'before' ? [...changes].reverse() : changes;
  for (const change of list) {
    const expected = side === 'before' ? change.after : change.before;
    if (!sameSnapshot(snapshotFile(change.path), expected)) {
      skipped++;
      continue;
    }
    if (restoreSnapshot(change.path, change[side])) restored++;
    else skipped++;
  }
  return { restored, skipped };
}

function restoreState(session, entry, side) {
  session.title = entry[`${side}Title`] || '';
  session.usage = clone(entry[`${side}Usage`] || {});
  session.contextWindow = entry[`${side}ContextWindow`] ?? null;
  session.lastContextTokens = entry[`${side}ContextTokens`] ?? null;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function sameSnapshot(left, right) {
  if (!left || !right || left.exists !== right.exists || left.type !== right.type) return false;
  if (!left.exists || left.type === 'directory') return true;
  if (left.restorable === false || right.restorable === false) {
    return left.size === right.size;
  }
  return left.encoding === right.encoding && left.content === right.content;
}

function trimHistory(entries) {
  const out = entries.slice(-MAX_ENTRIES);
  let bytes = Buffer.byteLength(JSON.stringify(out));
  while (out.length > 1 && bytes > MAX_HISTORY_BYTES) {
    out.shift();
    bytes = Buffer.byteLength(JSON.stringify(out));
  }
  if (bytes > MAX_HISTORY_BYTES) {
    for (const change of out[0]?.fileChanges || []) {
      change.before = { ...change.before, content: undefined, restorable: false };
      change.after = { ...change.after, content: undefined, restorable: false };
      change.restorable = false;
    }
  }
  return out;
}
