import fs from 'node:fs';
import path from 'node:path';
import { resourceRoots } from './commands.js';

const MAX_SKILL_BYTES = 40_000;
const MAX_TOTAL_BYTES = 120_000;

export function discoverSkills(cwd = process.cwd()) {
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
        const body = parsed.body.slice(0, MAX_SKILL_BYTES);
        if (total + body.length > MAX_TOTAL_BYTES) continue;
        skills.push({
          name: normalized,
          description: parsed.description || `skill ${normalized}`,
          body,
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

function parseSkill(source) {
  const text = String(source || '').trim();
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!frontmatter) return { description: '', body: text };
  const descriptionLine = frontmatter[1].split(/\r?\n/).find((line) => /^description\s*:/i.test(line));
  return {
    description: descriptionLine ? descriptionLine.replace(/^description\s*:/i, '').trim() : '',
    body: text.slice(frontmatter[0].length),
  };
}
