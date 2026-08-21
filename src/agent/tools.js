import fs from 'node:fs';
import path from 'node:path';
import { snapshotFile } from './history.js';
import { atomicWriteFile } from './session-format.js';
import { createPathPolicy } from './path-policy.js';
import { runProcess, shellInvocation } from './process-runner.js';
import { createToolRegistry, toToolDefinition } from './tool-contract.js';
import { buildDiffPayload } from '../ui/diff.js';
import { fetchUrl } from './web-fetch.js';
import { isGitMutating, runGitTool } from './git.js';
import { handleProjectDocs } from './project-docs.js';
import { isSkillMutating, manageSkill } from './skill-store.js';
import { isMcpMutating } from './mcp.js';

export { isGitMutating, isSkillMutating, isMcpMutating };
export const GOAL_TOOL_NAMES = new Set([
  'read_file', 'glob', 'grep', 'todo_write', 'web_fetch', 'git',
  'ask_question', 'project_docs', 'skill', 'list_mcp_tools',
]);
export const PARENT_ONLY_TOOLS = new Set(['task', 'ask_question']);

const TOOL_WIRE_SPECS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a shell command in the session working directory. Use for npm/pnpm, builds, tests, moving/renaming files, directory listing. Prefer the git tool for repository status/diff/log/stage/commit/checkout instead of bash git. Do NOT use bash to read/edit large source files — use read_file/edit_file/write_file instead. On Windows this runs via cmd.exe /c.',
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
  {
    type: 'function',
    function: {
      name: 'git',
      description:
        'Git operations in the workspace repository. Use status/diff/log/branch to inspect. Use stage/unstage/commit/checkout/discard/push/pull to change the repo. Prefer this over bash git. Only force-push when the user explicitly asks; force-push uses --force-with-lease unless lease=false.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'diff', 'log', 'stage', 'unstage', 'commit', 'discard', 'branch', 'checkout', 'push', 'pull', 'force-push'],
          },
          path: { type: 'string', description: 'File path for diff' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Paths for stage/unstage/commit/discard' },
          message: { type: 'string', description: 'Commit message' },
          staged: { type: 'boolean', description: 'If true, git diff --cached' },
          limit: { type: 'integer', description: 'Log entry count (default 20)' },
          ref: { type: 'string', description: 'Branch or ref for checkout/push/pull' },
          create: { type: 'boolean', description: 'Create branch on checkout' },
          remote: { type: 'string', description: 'Remote name (default origin)' },
          force: { type: 'boolean', description: 'Force push (prefer force-push action)' },
          lease: { type: 'boolean', description: 'Use --force-with-lease (default true)' },
          rebase: { type: 'boolean', description: 'git pull --rebase instead of --ff-only' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch a URL on this user\'s machine and return readable text. Use when the user pastes a link to read, or you need a docs/changelog page. This does NOT go through CheapAI servers. http(s) only. Prefer this over asking the user to paste the page.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http(s) URL to fetch locally' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_question',
      description:
        'Show a multiple-choice prompt and wait for the user\'s pick. Use this whenever the user must choose between approaches, scope, or next steps. Do NOT ask them to type 1 or 2 in chat. Provide 2–6 short option labels. Continue only after this tool returns the selected id/label.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Short question shown above the choices' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 8,
          },
        },
        required: ['prompt', 'options'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task',
      description:
        'Launch a focused subagent for one independent part of a large job. Use when the request is big enough to split into parallel workstreams. Multiple task calls in the SAME turn run in parallel. Give a self-contained prompt. Do not use for a tiny single-file edit. Subagents cannot spawn more subagents.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Self-contained instructions for the subagent.' },
          title: { type: 'string', description: 'Short dashboard label.' },
          description: { type: 'string', description: 'Optional one-line summary.' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'project_docs',
      description:
        'Project documentation mode helper. status lists docs/*.md. resolve_conflict asks whether code or docs is the source of truth when they disagree. Use resolve_conflict BEFORE editing if docs and code conflict.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'resolve_conflict'] },
          summary: { type: 'string', description: 'Short description of the mismatch' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill',
      description:
        'Create, list, update, enable, disable, delete, or import CheapAI skills. Skills are SKILL.md files. Use this when the user asks to make or save a reusable agent skill. name + instructions are required to create. action=import copies skills from Cursor/Claude/Codex.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'create', 'register', 'update', 'enable', 'disable', 'delete', 'import'] },
          id: { type: 'string' },
          name: { type: 'string' },
          names: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          instructions: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_manage',
      description:
        'Add, list, or remove MCP servers on this machine. catalog lists builtin servers (github, linear, notion, ...). connect accepts catalog_id or a remote url, or stdio command+args. After connect, use list_mcp_tools / call_mcp_tool.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['catalog', 'list', 'connect', 'disconnect'] },
          catalog_id: { type: 'string' },
          name: { type: 'string' },
          url: { type: 'string' },
          transport: { type: 'string', enum: ['http', 'sse', 'stdio'] },
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          pat: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_mcp_tools',
      description: 'List connected MCP servers and their tools. Call this before call_mcp_tool if you are unsure which servers are available.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'call_mcp_tool',
      description: 'Call a tool on a connected MCP server. Use list_mcp_tools first. Arguments must match the tool\'s input schema.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string' },
          tool: { type: 'string' },
          arguments: { type: 'object' },
        },
        required: ['server', 'tool'],
      },
    },
  },
];

const TOOL_POLICIES = {
  bash: { execution: 'sequential', sideEffect: 'process' },
  read_file: { execution: 'parallel', sideEffect: 'none' },
  write_file: { execution: 'sequential', sideEffect: 'filesystem' },
  edit_file: { execution: 'sequential', sideEffect: 'filesystem' },
  glob: { execution: 'parallel', sideEffect: 'none' },
  grep: { execution: 'parallel', sideEffect: 'none' },
  todo_write: { execution: 'sequential', sideEffect: 'none' },
  git: { execution: 'sequential', sideEffect: 'process' },
  web_fetch: { execution: 'parallel', sideEffect: 'network' },
  ask_question: { execution: 'sequential', sideEffect: 'none' },
  task: { execution: 'parallel', sideEffect: 'process' },
  project_docs: { execution: 'parallel', sideEffect: 'none' },
  skill: { execution: 'sequential', sideEffect: 'none' },
  mcp_manage: { execution: 'sequential', sideEffect: 'process' },
  list_mcp_tools: { execution: 'parallel', sideEffect: 'none' },
  call_mcp_tool: { execution: 'sequential', sideEffect: 'process' },
};

export const BUILTIN_TOOL_SPECS = TOOL_WIRE_SPECS.map((definition) => ({
  name: definition.function.name,
  description: definition.function.description,
  parameters: definition.function.parameters,
  ...TOOL_POLICIES[definition.function.name],
}));

export const TOOL_DEFINITIONS = BUILTIN_TOOL_SPECS.map(toToolDefinition);

export function createToolRuntime({
  cwd,
  onTodo,
  onFileChange,
  onBash,
  onProcessStart,
  pathMode = 'workspace',
  extraRoots = [],
  customTools = [],
  mcp = null,
  session = null,
  includeParentTools = true,
} = {}) {
  const root = path.resolve(cwd || process.cwd());
  const pathPolicy = createPathPolicy({ cwd: root, mode: pathMode, extraRoots });
  let todos = [];

  function resolveSafe(p) {
    return pathPolicy.resolve(p);
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
    const before = snapshotFile(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    atomicWriteFile(abs, content, { mode: existingFileMode(abs) });
    const after = snapshotFile(abs);
    onFileChange?.({ path: abs, before, after, restorable: before.restorable !== false && after.restorable !== false });
    const beforeText = snapshotText(before);
    const afterText = String(content ?? '');
    return {
      ok: true,
      path: abs,
      bytes: Buffer.byteLength(content, 'utf8'),
      // OpenCode-style before/after for the TUI (and a compact hint for the model).
      diff: buildDiffPayload(beforeText, afterText),
    };
  }

  function editFile(filePath, old_string, new_string, replace_all = false) {
    const abs = resolveSafe(filePath);
    if (!fs.existsSync(abs)) return { error: `File not found: ${abs}` };
    const before = snapshotFile(abs);
    const text = fs.readFileSync(abs, 'utf8');
    if (!text.includes(old_string)) {
      return { error: 'old_string not found in file' };
    }
    const count = text.split(old_string).length - 1;
    if (!replace_all && count > 1) {
      return { error: `old_string matched ${count} times; set replace_all=true or make it unique` };
    }
    const next = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, new_string);
    atomicWriteFile(abs, next, { mode: existingFileMode(abs) });
    const after = snapshotFile(abs);
    onFileChange?.({ path: abs, before, after, restorable: before.restorable !== false && after.restorable !== false });
    // Prefer the surgical span (old → new) so the UI shows the real edit, not the whole file.
    return {
      ok: true,
      path: abs,
      replacements: replace_all ? count : 1,
      diff: buildDiffPayload(String(old_string ?? ''), String(new_string ?? '')),
    };
  }

  function snapshotText(snapshot) {
    if (!snapshot?.exists || snapshot.type !== 'file') return '';
    if (snapshot.restorable === false) return '';
    if (snapshot.encoding === 'base64') {
      try {
        return Buffer.from(snapshot.content || '', 'base64').toString('utf8');
      } catch {
        return '';
      }
    }
    return String(snapshot.content || '');
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
        if (ent.isDirectory() && !ent.isSymbolicLink()) {
          walk(full);
          continue;
        }
        let safeFull;
        try {
          safeFull = resolveSafe(full);
          if (fs.statSync(safeFull).isDirectory()) continue;
        } catch {
          continue;
        }
        if (matchGlob(rel, pattern) || matchGlob(ent.name, pattern)) {
          results.push(safeFull);
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
      let safePath;
      try {
        safePath = resolveSafe(fp);
      } catch {
        continue;
      }
      let text;
      try {
        text = fs.readFileSync(safePath, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue; // binary skip
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= max_matches) break;
        if (re.test(lines[i])) {
          matches.push({ path: safePath, line: i + 1, text: lines[i].slice(0, 300) });
        }
      }
    }
    return { matches, truncated: matches.length >= max_matches };
  }

  async function executeImplementation(name, args, { signal, operationId, onUpdate, onProcess } = {}) {
    switch (name) {
      case 'bash':
        onBash?.(args.command);
        return runProcess({
          command: args.command,
          cwd: root,
          timeoutMs: args.timeout_ms || 120_000,
          signal,
          onStart: (processRecord) => {
            onProcessStart?.(operationId, processRecord);
            onProcess?.(processRecord);
            onUpdate?.({ type: 'process_started', ...processRecord });
          },
        });
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
      case 'git':
        return runGitTool({
          cwd: pathPolicy.workspace,
          args,
          resolvePath: (filePath) => resolveSafe(filePath),
          signal,
        });
      case 'web_fetch':
        return fetchUrl(args.url, { userAgent: 'CheapAI-CLI' });
      case 'ask_question':
        return { error: 'ask_question must be handled by the agent runtime' };
      case 'task':
        return { error: 'task must be launched by the parent agent runtime' };
      case 'project_docs':
        return handleProjectDocs(args, root, session || {});
      case 'skill':
        return manageSkill(args, root);
      case 'list_mcp_tools':
        return mcp ? mcp.listTools() : { servers: [] };
      case 'call_mcp_tool':
        return mcp ? mcp.callTool(args) : { error: 'No MCP manager' };
      case 'mcp_manage':
        return mcp ? mcp.manage(args) : { error: 'No MCP manager' };
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  const builtinContracts = BUILTIN_TOOL_SPECS
    .filter((spec) => includeParentTools || !PARENT_ONLY_TOOLS.has(spec.name))
    .map((spec) => ({
      ...spec,
      execute(callId, args, context) {
        return executeImplementation(spec.name, args, { ...context, operationId: callId });
      },
    }));
  const extensionContracts = customTools.map((tool) => ({
    execution: 'sequential',
    sideEffect: 'none',
    ...tool,
  }));
  const contracts = [...builtinContracts, ...extensionContracts];
  const registry = createToolRegistry(contracts);

  async function execute(name, args, context = {}) {
    const validation = registry.validate(name, args);
    if (!validation.ok) {
      return { ok: false, error: validation.error.message, code: validation.error.code };
    }
    try {
      const result = await validation.tool.execute(context.callId || name, args, context);
      return result === undefined ? { ok: true } : result;
    } catch (error) {
      return { ok: false, error: String(error?.message || error), code: error?.code || 'tool_error' };
    }
  }

  function detailFor(name, args) {
    if (name === 'bash') return args.command;
    if (name === 'read_file' || name === 'write_file' || name === 'edit_file') return String(args.path || '').trim();
    if (name === 'glob') return String(args.pattern || '').trim();
    if (name === 'grep') return `${args.pattern || ''}${args.path ? ` ${args.path}` : ''}`.trim();
    if (name === 'todo_write') return Array.isArray(args.todos) ? `${args.todos.length} task(s)` : '';
    if (name === 'git') {
      const extra = args.message || args.path || args.ref || '';
      return `git ${args.action || 'status'} ${extra}`.trim();
    }
    if (name === 'web_fetch') return String(args.url || '').trim();
    if (name === 'task') return String(args.title || args.prompt || 'subagent').split('\n').find((line) => line.trim())?.slice(0, 80) || 'subagent';
    if (name === 'ask_question') return String(args.prompt || args.title || 'choice');
    if (name === 'project_docs') return String(args.action || 'status');
    if (name === 'skill') return `skill ${args.action || 'list'} ${args.name || args.id || ''}`.trim();
    if (name === 'mcp_manage') return `mcp ${args.action || 'list'} ${args.name || args.url || args.catalog_id || ''}`.trim();
    if (name === 'call_mcp_tool') return `${args.server || ''}/${args.tool || ''}`;
    if (name === 'list_mcp_tools') return 'MCP tools';
    return `${name} ${JSON.stringify(args).slice(0, 180)}`.trim();
  }

  return {
    execute,
    detailFor,
    root,
    pathPolicy,
    registry,
    tools: contracts,
    getTodos: () => todos,
  };
}

function existingFileMode(filePath) {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return 0o666;
  }
}

export { shellInvocation };
