import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeDir } from '../config.js';
import { discoverSkills, parseSkill } from '../resources/skills.js';

const MAX_SKILLS = 50;

export function isSkillMutating(action) {
  return !['list', 'get'].includes(String(action || 'list'));
}

export function userSkillsDir() {
  return path.join(homeDir(), 'skills');
}

export function manageSkill(args = {}, cwd = process.cwd()) {
  const action = String(args.action || 'list').trim().toLowerCase();
  const mapped = action === 'register' ? 'create' : action;
  if (mapped === 'import') return importSkills(args, cwd);
  const skills = listManagedSkills(cwd);
  const note = 'Enabled skills apply to later turns in this session and to new sessions.';
  if (mapped === 'list') return { count: skills.length, skills: skills.map(summary) };
  if (mapped === 'get') {
    const skill = findSkill(skills, args);
    if (!skill) return { error: 'Skill not found. Pass id or name.' };
    return { skill };
  }
  if (mapped === 'create') {
    const name = slug(args.name);
    const instructions = String(args.instructions || '').trim();
    if (!name) return { error: 'name is required' };
    if (!instructions) return { error: 'instructions is required' };
    const existing = findSkill(skills, { name, id: args.id });
    if (existing && existing.scope !== 'bundled') return writeSkill(existing, { ...args, instructions }, 'updated', note);
    if (skills.filter((item) => item.scope === 'user').length >= MAX_SKILLS) return { error: 'Skill limit is 50.' };
    return writeSkill({ name, path: path.join(userSkillsDir(), name, 'SKILL.md') }, { ...args, instructions, enabled: args.enabled !== false }, 'created', note);
  }
  const current = findSkill(skills, args);
  if (!current) return { error: 'Skill not found. Pass id or name.' };
  if (current.scope === 'bundled') {
    return { error: 'Bundled skills are read-only. Create a user skill with the same name to override.' };
  }
  if (mapped === 'update') return writeSkill(current, args, 'updated', note);
  if (mapped === 'enable' || mapped === 'disable') {
    return writeSkill(current, { enabled: mapped === 'enable' }, mapped, note);
  }
  if (mapped === 'delete') {
    fs.rmSync(path.dirname(current.path), { recursive: true, force: true });
    return { ok: true, action: 'deleted', id: current.name, name: current.name };
  }
  return { error: `Unknown skill action: ${action}` };
}

export function importForeignSkills() {
  const found = [];
  const seen = new Set();
  for (const [source, root] of skillImportRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const skill of scanSkillDir(root, source)) {
      const key = skill.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(skill);
    }
  }
  return found;
}

function importSkills(args, cwd) {
  const discovered = importForeignSkills();
  const wanted = new Set((Array.isArray(args.names) ? args.names : [args.name]).map((name) => slug(name)).filter(Boolean));
  const selected = wanted.size ? discovered.filter((item) => wanted.has(item.name)) : discovered;
  let created = 0;
  let skipped = 0;
  const existing = new Set(listManagedSkills(cwd).map((item) => item.name));
  for (const skill of selected) {
    if (existing.has(skill.name)) {
      skipped += 1;
      continue;
    }
    writeSkill(
      { name: skill.name, path: path.join(userSkillsDir(), skill.name, 'SKILL.md') },
      { description: skill.description, instructions: skill.instructions, enabled: true },
      'created',
      '',
    );
    created += 1;
  }
  return { ok: true, action: 'import', created, skipped, available: discovered.map(summary) };
}

function listManagedSkills(cwd) {
  return discoverSkills(cwd, { includeDisabled: true }).map((skill) => ({
    id: skill.name,
    name: skill.name,
    description: skill.description,
    instructions: skill.body,
    enabled: skill.enabled !== false,
    path: skill.path,
    scope: skill.scope,
  }));
}

function findSkill(skills, args) {
  const id = String(args.id || args.name || '').trim().toLowerCase();
  if (!id) return null;
  return skills.find((skill) => skill.name === id || skill.id === id) || null;
}

function writeSkill(current, args, action, note) {
  const name = slug(args.name || current.name);
  const description = args.description != null ? String(args.description).trim() : current.description || '';
  const instructions = args.instructions != null ? String(args.instructions).trim() : current.instructions || '';
  const enabled = args.enabled != null ? !!args.enabled : current.enabled !== false;
  if (!name || !instructions) return { error: 'name and instructions are required' };
  const filePath = current.path && path.basename(path.dirname(current.path)) === name
    ? current.path
    : path.join(userSkillsDir(), name, 'SKILL.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const body = `---\nname: ${name}\ndescription: ${description}\nenabled: ${enabled}\n---\n\n${instructions.trim()}\n`;
  fs.writeFileSync(filePath, body, { encoding: 'utf8', mode: 0o600 });
  return {
    ok: true,
    action,
    note,
    skill: { id: name, name, description, instructions, enabled, path: filePath },
  };
}

function summary(skill) {
  return {
    id: skill.id || skill.name,
    name: skill.name,
    description: skill.description || '',
    enabled: skill.enabled !== false,
    source: skill.source || skill.scope,
  };
}

function slug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function skillImportRoots() {
  const home = os.homedir();
  return [
    ['Codex', path.join(home, '.codex', 'skills')],
    ['Claude', path.join(home, '.claude', 'skills')],
    ['Cursor', path.join(home, '.cursor', 'skills')],
    ['Agents', path.join(home, '.agents', 'skills')],
  ];
}

function scanSkillDir(root, source) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const skillFile = entry.isDirectory()
      ? [path.join(root, entry.name, 'SKILL.md'), path.join(root, entry.name, 'skill.md')].find((file) => fs.existsSync(file))
      : entry.name.toLowerCase() === 'skill.md'
        ? path.join(root, entry.name)
        : null;
    if (!skillFile) continue;
    try {
      const parsed = parseSkill(fs.readFileSync(skillFile, 'utf8'));
      const name = slug(parsed.name || entry.name);
      if (!name || !parsed.body.trim()) continue;
      out.push({
        id: `${source}:${name}`,
        source,
        name,
        description: parsed.description,
        instructions: parsed.body,
        path: skillFile,
      });
    } catch {
      /* skip */
    }
  }
  return out;
}
