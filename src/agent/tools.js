import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a shell command in the session working directory. Use for git, npm/pnpm, builds, tests, moving/renaming files, directory listing. Do NOT use bash to read/edit large source files — use read_file/edit_file/write_file instead. On Windows this runs via cmd.exe /c.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run' },
          timeout_ms: {
            type: 'integer',
            description: 'Timeout in milliseconds (default 120000)',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a UTF-8 text file from disk (real workspace). ALWAYS read before editing existing files. Optional 1-based offset/limit for large files. Returns numbered lines.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer', description: 'Start line (1-based)' },
          limit: { type: 'integer', description: 'Max lines to return' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create a new file or overwrite an entire file with full contents. Prefer edit_file for partial changes to existing files. Creates parent directories.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Surgical in-place edit: replace exact old_string with new_string (whitespace-sensitive). old_string must appear exactly once unless replace_all=true. Re-read the file if the match fails. Preferred over write_file for existing code.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files matching a glob pattern under a root directory.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'e.g. **/*.{ts,js}' },
          root: { type: 'string', description: 'Root directory (default cwd)' },
          max_results: { type: 'integer' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents with a regular expression.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'File or directory (default cwd)' },
          glob: { type: 'string', description: 'Optional filename filter e.g. *.js' },
          max_matches: { type: 'integer' },
          case_insensitive: { type: 'boolean' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: 'Update the task list for this session.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                content: { type: 'string' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                },
              },
              required: ['id', 'content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
];

export function createToolRuntime({ cwd, onTodo } = {}) {
  const root = path.resolve(cwd || process.cwd());
  let todos = [];

  function resolveSafe(p) {
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
    // allow any path for a local coding agent; still normalize
    return abs;
  }

  async function runBash(command, timeout_ms = 120_000) {
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const child = spawn(isWin ? 'cmd.exe' : 'bash', isWin ? ['/c', command] : ['-lc', command], {
        cwd: root,
        env: process.env,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({
          ok: false,
          exit_code: null,
          timed_out: true,
          stdout: stdout.slice(-30_000),
          stderr: (stderr + '\n[timeout]').slice(-10_000),
        });
      }, timeout_ms);
      child.stdout.on('data', (d) => {
        stdout += d.toString();
        if (stdout.length > 200_000) stdout = stdout.slice(-150_000);
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 100_000) stderr = stderr.slice(-80_000);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          ok: code === 0,
          exit_code: code,
          timed_out: false,
          stdout: stdout.slice(-50_000),
          stderr: stderr.slice(-20_000),
        });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, exit_code: null, error: String(err), stdout, stderr });
      });
    });
  }

  function readFile(filePath, offset, limit) {
    const abs = resolveSafe(filePath);
    if (!fs.existsSync(abs)) return { error: `File not found: ${abs}` };
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, offset || 1);
    const max = limit || 2000;
    const slice = lines.slice(start - 1, start - 1 + max);
    const numbered = slice.map((line, i) => `${start + i}|${line}`).join('\n');
    return {
      path: abs,
      total_lines: lines.length,
      content: numbered,
      truncated: start - 1 + max < lines.length,
    };
  }

  function writeFile(filePath, content) {
    const abs = resolveSafe(filePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    return { ok: true, path: abs, bytes: Buffer.byteLength(content, 'utf8') };
  }

  function editFile(filePath, old_string, new_string, replace_all = false) {
    const abs = resolveSafe(filePath);
    if (!fs.existsSync(abs)) return { error: `File not found: ${abs}` };
    const text = fs.readFileSync(abs, 'utf8');
    if (!text.includes(old_string)) {
      return { error: 'old_string not found in file' };
    }
    const count = text.split(old_string).length - 1;
    if (!replace_all && count > 1) {
      return { error: `old_string matched ${count} times; set replace_all=true or make it unique` };
    }
    const next = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, new_string);
    fs.writeFileSync(abs, next, 'utf8');
    return { ok: true, path: abs, replacements: replace_all ? count : 1 };
  }

  function matchGlob(rel, pattern) {
    // very small glob: ** / * / ?
    const norm = rel.replace(/\\/g, '/');
    const pat = String(pattern || '').replace(/\\/g, '/');
    // common "all files" patterns
    if (pat === '**/*' || pat === '**' || pat === '*' || pat === '*.*') return true;
    const esc = pat
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '::DS::')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/::DS::/g, '.*');
    // allow **/*.ext to match files in root too
    const re = new RegExp(`^${esc}$`, 'i');
    if (re.test(norm)) return true;
    // also match basename-only patterns like *.txt against full rel
    if (!pat.includes('/')) {
      const base = norm.split('/').pop() || norm;
      const reBase = new RegExp(
        `^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
        'i',
      );
      return reBase.test(base);
    }
    return false;
  }

  function walkGlob(startDir, pattern, max_results = 200) {
    const results = [];
    const base = resolveSafe(startDir || root);
    function walk(dir) {
      if (results.length >= max_results) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (results.length >= max_results) break;
        if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist') continue;
        const full = path.join(dir, ent.name);
        const rel = path.relative(base, full).replace(/\\/g, '/');
        if (ent.isDirectory()) walk(full);
        else if (matchGlob(rel, pattern) || matchGlob(ent.name, pattern)) {
          results.push(full);
        }
      }
    }
    // If pattern has no slash, search basename; if absolute-ish, still from base
    walk(base);
    return results;
  }

  function grepSearch({ pattern, searchPath, globFilter, max_matches = 50, case_insensitive = false }) {
    let re;
    try {
      re = new RegExp(pattern, case_insensitive ? 'i' : '');
    } catch (e) {
      return { error: `Invalid regex: ${e.message}` };
    }
    const base = resolveSafe(searchPath || root);
    const matches = [];
    const files = [];

    function considerFile(fp) {
      if (globFilter) {
        const name = path.basename(fp);
        if (!matchGlob(name, globFilter) && !matchGlob(path.relative(base, fp).replace(/\\/g, '/'), globFilter)) {
          return;
        }
      }
      files.push(fp);
    }

    if (fs.existsSync(base) && fs.statSync(base).isFile()) {
      considerFile(base);
    } else {
      for (const f of walkGlob(base, '**/*', 5000)) considerFile(f);
    }

    for (const fp of files) {
      if (matches.length >= max_matches) break;
      let text;
      try {
        text = fs.readFileSync(fp, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue; // binary skip
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= max_matches) break;
        if (re.test(lines[i])) {
          matches.push({ path: fp, line: i + 1, text: lines[i].slice(0, 300) });
        }
      }
    }
    return { matches, truncated: matches.length >= max_matches };
  }

  async function execute(name, args) {
    switch (name) {
      case 'bash':
        return runBash(args.command, args.timeout_ms || 120_000);
      case 'read_file':
        return readFile(args.path, args.offset, args.limit);
      case 'write_file':
        return writeFile(args.path, args.content);
      case 'edit_file':
        return editFile(args.path, args.old_string, args.new_string, !!args.replace_all);
      case 'glob':
        return {
          files: walkGlob(args.root || root, args.pattern, args.max_results || 200),
        };
      case 'grep':
        return grepSearch({
          pattern: args.pattern,
          searchPath: args.path,
          globFilter: args.glob,
          max_matches: args.max_matches || 50,
          case_insensitive: !!args.case_insensitive,
        });
      case 'todo_write':
        todos = args.todos || [];
        onTodo?.(todos);
        return { ok: true, todos };
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  function detailFor(name, args) {
    if (name === 'bash') return args.command;
    if (name === 'write_file' || name === 'edit_file' || name === 'read_file') return args.path;
    return JSON.stringify(args).slice(0, 200);
  }

  return { execute, detailFor, root, getTodos: () => todos };
}

// silence unused import warning in some bundlers
void pathToFileURL;
