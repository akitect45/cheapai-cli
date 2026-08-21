import fs from 'node:fs';
import path from 'node:path';
import { resourceRoots } from './commands.js';

const MAX_SKILL_BYTES = 40_000;
const MAX_TOTAL_BYTES = 120_000;

export function discoverSkills(cwd = process.cwd(), { includeDisabled = false } = {}) {
  const roots = resourceRoots(cwd, 'skills');
  const seen = new Set();
  const skills = [];
  let total = 0;
  for (const { directory, scope, root } of roots) {
    if (!fs.existsSync(directory)) continue;
    let names;
    try {
      names = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const normalized = name.toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized) || seen.has(normalized)) continue;
      const filePath = path.resolve(directory, name, 'SKILL.md');
      if (!fs.existsSync(filePath)) continue;
      try {
        const source = fs.readFileSync(filePath, 'utf8');
        const parsed = parseSkill(source);
        if (parsed.enabled === false && !includeDisabled) continue;
        const body = parsed.body.slice(0, MAX_SKILL_BYTES);
        if (total + body.length > MAX_TOTAL_BYTES) continue;
        skills.push({
          name: parsed.name || normalized,
          description: parsed.description || `skill ${normalized}`,
          body,
          enabled: parsed.enabled !== false,
          path: filePath,
          scope,
          provenance: root,
        });
        total += body.length;
        seen.add(normalized);
      } catch {
        /* Discovery never executes or imports skill content. */
      }
    }
  }
  return skills;
}

export function parseSkill(source) {
  const text = String(source || '').trim();
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!frontmatter) return { name: '', description: '', enabled: true, body: text };
  const fields = Object.fromEntries(frontmatter[1].split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    return match ? [[match[1].toLowerCase(), match[2].trim().replace(/^['"]|['"]$/g, '')]] : [];
  }));
  return {
    name: String(fields.name || '').trim().toLowerCase(),
    description: fields.description || '',
    enabled: !/^(false|0|off|no)$/i.test(String(fields.enabled || 'true')),
    body: text.slice(frontmatter[0].length),
  };
}
