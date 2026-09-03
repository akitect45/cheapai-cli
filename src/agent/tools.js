import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
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
import { dispatchResearch, isResearchMutating } from '../research/index.js';
import { applyEdits, normalizeEditList } from './edit-match.js';
import { escapeRegExp, matchGlob, walkFiles } from './fs-walk.js';

export { isGitMutating, isSkillMutating, isMcpMutating, isResearchMutating };
export const GOAL_TOOL_NAMES = new Set([
  'read_file', 'list_dir', 'glob', 'grep', 'todo_write', 'web_fetch', 'git',
  'ask_question', 'project_docs', 'skill', 'list_mcp_tools',
]);
const MAX_INLINE_READ_BYTES = 4 * 1024 * 1024;
export const PARENT_ONLY_TOOLS = new Set(['task', 'ask_question']);

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  throw error;
}

const TOOL_WIRE_SPECS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a shell command. Use for package managers, builds, tests, and commands with no dedicated tool. Prefer list_dir/glob/grep/read_file/edit_file/move_file/delete_file/git over shell for those jobs. On Windows this runs via cmd.exe /c.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run' },
          working_directory: {
            type: 'string',
            description: 'Directory to run in (must stay inside the authorized workspace)',
          },
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
        'Read a UTF-8 text file from disk. ALWAYS read before editing existing files. Optional 1-based offset/limit for large files. Returns numbered lines (N|text). Binary files are rejected. If truncated, call again with next_offset.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer', description: 'Start line (1-based)' },
          limit: { type: 'integer', description: 'Max lines to return (default 2000, max 5000)' },
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
        'Surgical in-place edit. Provide old_string/new_string, or edits[] for several replacements in one file. old_string must be unique unless replace_all=true. CRLF/LF differences are tolerated. If a match fails, the result includes hint and similar lines — use those instead of rewriting the whole file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
          edits: {
            type: 'array',
            description: 'Multiple replacements applied in order to the same file',
            items: {
              type: 'object',
              properties: {
                old_string: { type: 'string' },
                new_string: { type: 'string' },
                replace_all: { type: 'boolean' },
              },
              required: ['old_string', 'new_string'],
            },
          },
        },
        required: ['path'],
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
      description:         'Search file contents. pattern is a regular expression unless fixed_string=true. Use context for surrounding lines. Skips node_modules, .git, and other build directories.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'File or directory (default cwd)' },
          glob: { type: 'string', description: 'Optional filename filter e.g. *.js' },
          max_matches: { type: 'integer' },
          case_insensitive: { type: 'boolean' },
          fixed_string: { type: 'boolean', description: 'Treat pattern as a literal string' },
          context: { type: 'integer', description: 'Lines of context around each match (0-5)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description:
        'List one directory (name, type, size). Prefer this over bash ls/dir. Use glob for recursive filename search.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to list (default workspace root)' },
          max_entries: { type: 'integer', description: 'Max entries to return (default 200)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description:
        'Delete one file, or an empty directory, inside the workspace. Prefer this over bash rm. Refuses non-empty directories.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description:
        'Rename or move one file inside the workspace. Prefer this over bash mv. Set overwrite=true to replace an existing destination. Directories are not moved.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          overwrite: { type: 'boolean' },
        },
        required: ['from', 'to'],
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
      name: 'research',
      description:
        'Workspace research harness. init a METRIC/ASI experiment under .cheapai/autoresearch, run a benchmark command, status the ledger, flag a bad run, or clear. Research-only: do not change product source. Prefer this over raw bash when logging keep/discard metrics.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['init', 'run', 'status', 'flag', 'clear'] },
          goal: { type: 'string', description: 'Research question for init' },
          name: { type: 'string', description: 'Experiment name' },
          primaryMetric: { type: 'string', description: 'Primary METRIC name (default metric)' },
          direction: { type: 'string', enum: ['lower', 'higher'] },
          command: { type: 'string', description: 'Harness command for init/run' },
          description: { type: 'string', description: 'Optional note stored on a run' },
          runId: { type: 'string', description: 'Run id or number for flag' },
          reason: { type: 'string', description: 'Why a run is flagged' },
          timeout_ms: { type: 'integer', description: 'Run timeout in milliseconds' },
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
  list_dir: { execution: 'parallel', sideEffect: 'none' },
  delete_file: { execution: 'sequential', sideEffect: 'filesystem' },
  move_file: { execution: 'sequential', sideEffect: 'filesystem' },
  glob: { execution: 'parallel', sideEffect: 'none' },
  grep: { execution: 'parallel', sideEffect: 'none' },
  todo_write: { execution: 'sequential', sideEffect: 'none' },
  git: { execution: 'sequential', sideEffect: 'process' },
  web_fetch: { execution: 'parallel', sideEffect: 'network' },
  ask_question: { execution: 'sequential', sideEffect: 'none' },
  task: { execution: 'parallel', sideEffect: 'process' },
  project_docs: { execution: 'parallel', sideEffect: 'none' },
  research: { execution: 'sequential', sideEffect: 'process' },
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

  function yieldToEventLoop() {
    return new Promise((resolve) => setImmediate(resolve));
  }

  async function readFile(filePath, offset, limit, signal = null) {
    const abs = resolveSafe(filePath);
    let stat;
    try {
      stat = await fs.promises.stat(abs);
    } catch (error) {
      if (error?.code === 'ENOENT') return { error: `File not found: ${abs}` };
      return { error: String(error?.message || error) };
    }
    if (stat.isDirectory()) return { error: `Path is a directory: ${abs}. Use list_dir.` };
    const start = Math.max(1, Number(offset) || 1);
    const max = Math.min(5000, Math.max(1, Number(limit) || 2000));
    if (stat.size > MAX_INLINE_READ_BYTES) {
      return readFileStreamed(abs, start, max, signal);
    }
    let buf;
    try {
      buf = await fs.promises.readFile(abs);
    } catch (error) {
      return { error: String(error?.message || error) };
    }
    if (buf.includes(0)) return { error: `Binary file: ${abs}` };
    const lines = buf.toString('utf8').split(/\r?\n/);
    const slice = lines.slice(start - 1, start - 1 + max);
    const numbered = slice.map((line, i) => `${start + i}|${line}`).join('\n');
    const truncated = start - 1 + max < lines.length;
    return {
      path: abs,
      total_lines: lines.length,
      content: numbered,
      truncated,
      ...(truncated ? { next_offset: start + slice.length, hint: `Pass offset=${start + slice.length} to continue.` } : {}),
    };
  }

  async function readFileStreamed(abs, start, max, signal) {
    throwIfAborted(signal);
    if (await fileLooksBinary(abs)) return { error: `Binary file: ${abs}` };
    const stream = fs.createReadStream(abs, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const abort = () => {
      rl.close();
      stream.destroy();
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const slice = [];
      let lineNo = 0;
      for await (const line of rl) {
        throwIfAborted(signal);
        lineNo += 1;
        if (lineNo >= start && slice.length < max) slice.push(`${lineNo}|${line}`);
      }
      const truncated = start - 1 + max < lineNo;
      return {
        path: abs,
        total_lines: lineNo,
        content: slice.join('\n'),
        truncated,
        ...(truncated ? { next_offset: start + slice.length, hint: `Pass offset=${start + slice.length} to continue.` } : {}),
      };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return { error: String(error?.message || error) };
    } finally {
      signal?.removeEventListener('abort', abort);
      rl.close();
      stream.destroy();
    }
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

  function editFile(args) {
    const abs = resolveSafe(args.path);
    if (!fs.existsSync(abs)) return { error: `File not found: ${abs}` };
    const edits = normalizeEditList(args);
    if (!edits) return { error: 'Provide old_string/new_string or edits[].' };
    const before = snapshotFile(abs);
    const text = fs.readFileSync(abs, 'utf8');
    if (text.includes('\0')) return { error: `Binary file: ${abs}` };
    const applied = applyEdits(text, edits);
    if (!applied.ok) return applied;
    atomicWriteFile(abs, applied.text, { mode: existingFileMode(abs) });
    const after = snapshotFile(abs);
    onFileChange?.({ path: abs, before, after, restorable: before.restorable !== false && after.restorable !== false });
    const first = edits[0] || {};
    return {
      ok: true,
      path: abs,
      replacements: applied.replacements,
      edits: applied.edits,
      diff: buildDiffPayload(String(first.old_string ?? ''), String(first.new_string ?? '')),
    };
  }

  async function listDir(dirPath, maxEntries = 200, signal = null) {
    throwIfAborted(signal);
    const abs = resolveSafe(dirPath || root);
    let stat;
    try {
      stat = await fs.promises.stat(abs);
    } catch (error) {
      if (error?.code === 'ENOENT') return { error: `Directory not found: ${abs}` };
      return { error: String(error?.message || error) };
    }
    if (!stat.isDirectory()) return { error: `Not a directory: ${abs}` };
    const names = await fs.promises.readdir(abs);
    names.sort((a, b) => a.localeCompare(b));
    const limit = Math.min(1000, Math.max(1, Number(maxEntries) || 200));
    const entries = [];
    for (const name of names) {
      throwIfAborted(signal);
      if (entries.length >= limit) break;
      const full = path.join(abs, name);
      try {
        resolveSafe(full);
        const info = await fs.promises.lstat(full);
        const entry = {
          name,
          type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'dir' : 'file',
        };
        if (entry.type === 'file') entry.size = info.size;
        entries.push(entry);
      } catch {
        continue;
      }
    }
    return {
      path: abs,
      entries,
      total: names.length,
      truncated: names.length > entries.length,
    };
  }

  function deleteFile(filePath) {
    const abs = resolveSafe(filePath);
    if (!fs.existsSync(abs)) return { error: `File not found: ${abs}` };
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) {
      const before = snapshotFile(abs);
      fs.unlinkSync(abs);
      onFileChange?.({ path: abs, before, after: { exists: false, type: 'file' }, restorable: false });
      return { ok: true, path: abs, deleted: 'symlink' };
    }
    if (stat.isDirectory()) {
      const children = fs.readdirSync(abs);
      if (children.length) {
        return { error: `Directory is not empty: ${abs}. Delete files first or use bash.` };
      }
      fs.rmdirSync(abs);
      return { ok: true, path: abs, deleted: 'directory' };
    }
    const before = snapshotFile(abs);
    fs.unlinkSync(abs);
    onFileChange?.({
      path: abs,
      before,
      after: { exists: false, type: 'file' },
      restorable: before.restorable !== false,
    });
    return { ok: true, path: abs, deleted: 'file' };
  }

  function moveFile(fromPath, toPath, overwrite = false) {
    const src = resolveSafe(fromPath);
    const dest = resolveSafe(toPath);
    if (!fs.existsSync(src)) return { error: `File not found: ${src}` };
    const srcStat = fs.lstatSync(src);
    if (srcStat.isDirectory()) return { error: 'Moving directories is not supported. Use bash.' };
    if (src === dest) return { ok: true, from: src, to: dest, unchanged: true };
    if (fs.existsSync(dest) && !overwrite) {
      return { error: `Destination exists: ${dest}. Set overwrite=true to replace it.` };
    }
    const beforeSrc = snapshotFile(src);
    const beforeDest = snapshotFile(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    const afterDest = snapshotFile(dest);
    onFileChange?.({
      path: src,
      before: beforeSrc,
      after: { exists: false, type: 'file' },
      restorable: beforeSrc.restorable !== false,
    });
    onFileChange?.({
      path: dest,
      before: beforeDest,
      after: afterDest,
      restorable: beforeDest.restorable !== false && afterDest.restorable !== false,
    });
    return { ok: true, from: src, to: dest };
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

  async function walkGlob(startDir, pattern, max_results = 200, signal = null) {
    const base = resolveSafe(startDir || root);
    return walkFiles({
      base,
      pattern,
      maxResults: max_results,
      signal,
      resolveSafe,
      throwIfAborted,
      yieldToEventLoop,
    });
  }

  async function grepSearch({
    pattern,
    searchPath,
    globFilter,
    max_matches = 50,
    case_insensitive = false,
    fixed_string = false,
    context = 0,
    signal = null,
  }) {
    throwIfAborted(signal);
    let re;
    try {
      const source = fixed_string ? escapeRegExp(pattern) : pattern;
      re = new RegExp(source, case_insensitive ? 'i' : '');
    } catch (e) {
      return { error: `Invalid regex: ${e.message}` };
    }
    const ctx = Math.min(5, Math.max(0, Number(context) || 0));
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

    try {
      const st = await fs.promises.stat(base);
      if (st.isFile()) considerFile(base);
      else {
        const walked = await walkGlob(base, '**/*', 5000, signal);
        for (const f of walked) considerFile(f);
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return { matches, truncated: false };
    }

    for (let index = 0; index < files.length; index++) {
      if (matches.length >= max_matches) break;
      if (index % 8 === 0) {
        await yieldToEventLoop();
        throwIfAborted(signal);
      }
      const fp = files[index];
      let safePath;
      try {
        safePath = resolveSafe(fp);
      } catch {
        continue;
      }
      let text;
      try {
        text = await fs.promises.readFile(safePath, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= max_matches) break;
        re.lastIndex = 0;
        if (!re.test(lines[i])) continue;
        re.lastIndex = 0;
        const match = { path: safePath, line: i + 1, text: lines[i].slice(0, 300) };
        if (ctx > 0) {
          match.before = lines.slice(Math.max(0, i - ctx), i).map((line) => line.slice(0, 300));
          match.after = lines.slice(i + 1, i + 1 + ctx).map((line) => line.slice(0, 300));
        }
        matches.push(match);
      }
    }
    return { matches, truncated: matches.length >= max_matches };
  }

  async function executeImplementation(name, args, { signal, operationId, onUpdate, onProcess } = {}) {
    throwIfAborted(signal);
    await yieldToEventLoop();
    switch (name) {
      case 'bash':
        onBash?.(args.command);
        return runProcess({
          command: args.command,
          cwd: args.working_directory ? resolveSafe(args.working_directory) : root,
          timeoutMs: args.timeout_ms || 120_000,
          signal,
          onStart: (processRecord) => {
            onProcessStart?.(operationId, processRecord);
            onProcess?.(processRecord);
            onUpdate?.({ type: 'process_started', ...processRecord });
          },
        });
      case 'read_file':
        return readFile(args.path, args.offset, args.limit, signal);
      case 'write_file':
        return writeFile(args.path, args.content);
      case 'edit_file':
        return editFile(args);
      case 'list_dir':
        return listDir(args.path, args.max_entries, signal);
      case 'delete_file':
        return deleteFile(args.path);
      case 'move_file':
        return moveFile(args.from, args.to, !!args.overwrite);
      case 'glob': {
        const maxResults = args.max_results || 200;
        const files = await walkGlob(args.root || root, args.pattern, maxResults, signal);
        return { files, truncated: files.length >= maxResults };
      }
      case 'grep':
        return grepSearch({
          pattern: args.pattern,
          searchPath: args.path,
          globFilter: args.glob,
          max_matches: args.max_matches || 50,
          case_insensitive: !!args.case_insensitive,
          fixed_string: !!args.fixed_string,
          context: args.context,
          signal,
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
      case 'research':
        return dispatchResearch({
          cwd: root,
          action: args.action,
          goal: args.goal,
          name: args.name,
          primaryMetric: args.primaryMetric,
          direction: args.direction,
          command: args.command,
          description: args.description,
          runId: args.runId,
          reason: args.reason,
          timeoutMs: args.timeout_ms,
          signal,
          onProcess: (processRecord) => {
            onProcessStart?.(operationId, processRecord);
            onProcess?.(processRecord);
            onUpdate?.({ type: 'process_started', ...processRecord });
          },
        });
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
      if (error?.name === 'AbortError') throw error;
      return { ok: false, error: String(error?.message || error), code: error?.code || 'tool_error' };
    }
  }

  function detailFor(name, args) {
    if (name === 'bash') return args.command;
    if (name === 'read_file' || name === 'write_file' || name === 'edit_file' || name === 'delete_file' || name === 'list_dir') {
      return String(args.path || '').trim();
    }
    if (name === 'move_file') return `${args.from || ''} → ${args.to || ''}`.trim();
    if (name === 'glob') return String(args.pattern || '').trim();
    if (name === 'grep') return `${args.pattern || ''}${args.path ? ` ${args.path}` : ''}`.trim();
    if (name === 'todo_write') return Array.isArray(args.todos) ? `${args.todos.length} task(s)` : '';
    if (name === 'canvas_write') return String(args.title || args.id || '').trim();
    if (name === 'git') {
      const extra = args.message || args.path || args.ref || '';
      return `git ${args.action || 'status'} ${extra}`.trim();
    }
    if (name === 'web_fetch') return String(args.url || '').trim();
    if (name === 'task') return String(args.title || args.prompt || 'subagent').split('\n').find((line) => line.trim())?.slice(0, 80) || 'subagent';
    if (name === 'ask_question') return String(args.prompt || args.title || 'choice');
    if (name === 'project_docs') return String(args.action || 'status');
    if (name === 'research') return `research ${args.action || 'status'} ${args.command || args.goal || args.runId || ''}`.trim();
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

async function fileLooksBinary(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

export { shellInvocation };
