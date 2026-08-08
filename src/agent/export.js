import fs from 'node:fs';
import path from 'node:path';
import { ensureHome, homeDir } from '../config.js';

export function exportSession(session, targetPath = '') {
  ensureHome();
  const destination = targetPath
    ? path.resolve(session.cwd || process.cwd(), targetPath)
    : path.join(homeDir(), 'exports', `cheapai-${session.id.slice(0, 8)}.md`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, sessionMarkdown(session), 'utf8');
  return destination;
}

export function sessionMarkdown(session) {
  const lines = [
    `# ${session.title || 'CheapAI session'}`,
    '',
    `- Session: ${session.id}`,
    `- Workspace: ${session.cwd || '—'}`,
    `- Model: ${session.model || '—'}`,
    '',
  ];
  for (const message of session.messages || []) {
    if (message?.role === 'system') continue;
    const role = message?.role === 'user' ? 'User' : message?.role === 'assistant' ? 'Assistant' : 'Tool';
    lines.push(`## ${role}`, '', messageText(message?.content) || '(empty)', '');
    if (message?.tool_calls?.length) {
      lines.push('```json', JSON.stringify(message.tool_calls, null, 2), '```', '');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function messageText(content) {
  if (Array.isArray(content)) return content.map((part) => part?.text || part?.content || '').join('');
  return typeof content === 'string' ? content : content == null ? '' : JSON.stringify(content, null, 2);
}
