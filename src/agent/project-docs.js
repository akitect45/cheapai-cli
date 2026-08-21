import fs from 'node:fs';
import path from 'node:path';

export function projectDocsEnabled(config = {}) {
  return config.projectDocs === true;
}

export function listMarkdownDocs(cwd) {
  const root = path.join(path.resolve(cwd || process.cwd()), 'docs');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const files = [];
  collect(root, path.resolve(cwd || process.cwd()), files, 0);
  files.sort();
  return files.slice(0, 40);
}

export function looksLarge(text) {
  const trimmed = String(text || '').trim();
  if ([...trimmed].length >= 120) return true;
  const lower = trimmed.toLowerCase();
  return [
    '구현', '아키텍처', '설계', '리팩터', '리팩토', '기능 추가', '마이그레이',
    '만들어', '추가해', '고쳐', '바꿔줘', '전체', '모듈',
    'architecture', 'refactor', 'implement', 'feature', 'migrate', 'restructure', 'redesign',
  ].some((key) => lower.includes(key.toLowerCase()));
}

export function projectDocsInstruction(cwd, session = {}) {
  const files = listMarkdownDocs(cwd);
  const status = files.length
    ? `PRESENT — ${files.length} file(s): ${files.join(', ')}`
    : 'MISSING — there is no docs/ folder with markdown yet.';
  const source = session.projectDocs?.source;
  const sourceBlock = source === 'docs'
    ? '\n# Project documentation source of truth\nThis session, docs win. Change code to match markdown under docs/.'
    : source === 'code'
      ? '\n# Project documentation source of truth\nThis session, code wins. Update markdown under docs/ so it matches the implementation.'
      : '';
  return `# Project documentation mode
ON. Durable notes live under \`docs/\` at the workspace root. Status: ${status}

Large work = new feature, architecture change, multi-file refactor, or anything that needs a plan. Tiny Q&A and one-line fixes skip this.

- If MISSING and the job is large: wait for the create vs skip prompt, or call project_docs. Create → write useful markdown under docs/ first, then implement. Skip → no docs this session. YOLO creates docs and implements immediately.
- After code changes that affect documented behavior, update the matching docs/*.md in the same turn.
- If docs disagree with code at the start, call project_docs action=resolve_conflict before editing.
- Prefer a few durable files (docs/architecture.md, docs/plan.md, feature notes) — not chat logs.${sourceBlock}`;
}

export function handleProjectDocs(args = {}, cwd, session = {}) {
  const action = String(args.action || 'status');
  if (action === 'resolve_conflict') {
    const source = session.projectDocs?.source;
    if (source !== 'code' && source !== 'docs') {
      return { error: 'No source-of-truth choice yet. Ask the user whether code or docs should win.' };
    }
    return {
      ok: true,
      source,
      instruction: source === 'docs'
        ? 'Docs win. Change code to match the markdown under docs/. Do not weaken the docs to match buggy code.'
        : 'Code wins. Update the markdown under docs/ so it matches the implementation.',
    };
  }
  const files = listMarkdownDocs(cwd);
  return { ok: true, enabled: true, missing: files.length === 0, files };
}

function collect(dir, cwd, files, depth) {
  if (depth > 6 || files.length >= 40) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(full, cwd, files, depth + 1);
      continue;
    }
    if (entry.name.toLowerCase().endsWith('.md')) {
      files.push(path.relative(cwd, full).replace(/\\/g, '/'));
    }
  }
}
