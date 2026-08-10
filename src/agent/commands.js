import fs from 'node:fs';
import path from 'node:path';
import { discoverCommands, renderCommand } from '../resources/commands.js';
import { homeDir } from '../config.js';

export function loadCustomCommands(cwd) {
  return discoverCommands(cwd);
}

export function renderCustomCommand(command, args = '') {
  return renderCommand(command, args);
}

export function loadCustomAgents(cwd) {
  const roots = [];
  let dir = path.resolve(cwd || process.cwd());
  const root = path.parse(dir).root;
  while (true) {
    roots.push(path.join(dir, '.opencode', 'agents'));
    roots.push(path.join(dir, '.cheapai', 'agents'));
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  roots.push(path.join(homeDir(), 'agents'));

  const seen = new Set();
  const agents = [];
  for (const directory of roots) {
    if (!fs.existsSync(directory)) continue;
    let files;
    try {
      files = fs.readdirSync(directory).filter((file) => file.endsWith('.md')).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const name = path.basename(file, '.md').toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name) || seen.has(name)) continue;
      try {
        const parsed = parseCommand(fs.readFileSync(path.join(directory, file), 'utf8'));
        agents.push({ name, description: parsed.description || `custom agent from ${file}`, instructions: parsed.template });
        seen.add(name);
      } catch {
        /* ignore malformed agent files */
      }
    }
  }
  return agents;
}

function parseCommand(source) {
  const text = String(source || '').trim();
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  let description = '';
  let template = text;
  if (frontmatter) {
    const line = frontmatter[1].split(/\r?\n/).find((item) => /^description\s*:/i.test(item));
    description = line ? line.replace(/^description\s*:/i, '').trim() : '';
    template = text.slice(frontmatter[0].length);
  }
  return { description, template };
}
