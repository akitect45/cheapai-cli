import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../config.js';

export function discoverCommands(cwd = process.cwd()) {
  const roots = resourceRoots(cwd, 'commands');
  const seen = new Set();
  const commands = [];
  for (const { directory, scope, root } of roots) {
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
      const filePath = path.resolve(directory, file);
      try {
        const parsed = parseMarkdown(fs.readFileSync(filePath, 'utf8'));
        commands.push({
          name,
          description: parsed.description || `custom command from ${file}`,
          template: parsed.body,
          path: filePath,
          scope,
          provenance: root,
        });
        seen.add(name);
      } catch {
        /* Ignore malformed resource files. */
      }
    }
  }
  return commands;
}

export function renderCommand(command, args = '') {
  const values = String(args || '').trim().split(/\s+/).filter(Boolean);
  return String(command?.template || '')
    .replace(/\$ARGUMENTS\b/g, String(args || '').trim())
    .replace(/\$([0-9]+)/g, (_, index) => values[Number(index) - 1] || '')
    .trim();
}

export function resourceRoots(cwd, kind) {
  const roots = [];
  let dir = path.resolve(cwd || process.cwd());
  const root = path.parse(dir).root;
  let depth = 0;
  while (true) {
    roots.push({ directory: path.join(dir, '.opencode', kind), scope: 'project', root: dir, depth });
    roots.push({ directory: path.join(dir, '.cheapai', kind), scope: 'project', root: dir, depth });
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    depth++;
  }
  roots.push({ directory: path.join(homeDir(), kind), scope: 'user', root: homeDir(), depth: Infinity });
  return roots;
}

function parseMarkdown(source) {
  const text = String(source || '').trim();
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!frontmatter) return { description: '', body: text };
  const descriptionLine = frontmatter[1].split(/\r?\n/).find((line) => /^description\s*:/i.test(line));
  return {
    description: descriptionLine ? descriptionLine.replace(/^description\s*:/i, '').trim() : '',
    body: text.slice(frontmatter[0].length),
  };
}
