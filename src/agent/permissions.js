import { t, icons } from '../ui/theme.js';
import { selectMenu } from '../ui/select.js';
import { isGitMutating } from './git.js';
import { isMcpMutating } from './mcp.js';
import { isResearchMutating } from '../research/index.js';
import { isSkillMutating } from './skill-store.js';

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'move_file', 'bash', 'todo_write', 'git', 'call_mcp_tool']);
const READ_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'grep', 'web_fetch', 'ask_question', 'project_docs', 'list_mcp_tools', 'task']);

/**
 * @param {'ask'|'auto'|'accept-edits'|'yolo'} mode
 */
export function createPermissionGate(mode = 'ask', requestApproval = null, {
  interactive,
  allowTodo = false,
  toolResolver = null,
} = {}) {
  const m = mode || 'ask';
  const canPrompt = interactive ?? (process.stdin.isTTY && process.stdout.isTTY);

  function allowedWithoutPrompt(toolName, args = {}) {
    if (m === 'yolo') return true;
    if (m === 'strict') return false;
    if (toolName === 'web_fetch' || toolName === 'ask_question' || toolName === 'task' || toolName === 'project_docs' || toolName === 'list_mcp_tools') return true;
    if (toolName === 'git') return !isGitMutating(args.action);
    if (toolName === 'skill') return !isSkillMutating(args.action);
    if (toolName === 'research') return !isResearchMutating(args.action);
    if (toolName === 'mcp_manage') return !isMcpMutating(toolName, args);
    const sideEffect = toolResolver?.(toolName)?.sideEffect;
    if (sideEffect === 'none' || READ_TOOLS.has(toolName)) return true;
    if (allowTodo && toolName === 'todo_write') return true;
    if (m === 'accept-edits' && ['write_file', 'edit_file', 'delete_file', 'move_file', 'todo_write'].includes(toolName)) {
      return true;
    }
    if (m === 'auto' && READ_TOOLS.has(toolName)) return true;
    return false;
  }

  return {
    mode: m,
    requiresApproval(toolName, args = {}) {
      return !allowedWithoutPrompt(toolName, args);
    },
    async approve(toolName, detail, { signal = null, args = {} } = {}) {
      if (signal?.aborted) return false;
      if (allowedWithoutPrompt(toolName, args)) return true;
      const pending = requestApproval
        ? requestApproval(toolName, detail, { signal })
        : askUser(toolName, detail, canPrompt);
      return await abortable(pending, signal);
    },
  };
}

async function abortable(value, signal) {
  if (!signal) return value;
  if (signal.aborted) return false;
  return new Promise((resolve) => {
    const onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then((result) => {
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    }, () => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    });
  });
}

async function askUser(toolName, detail, interactive) {
  if (!interactive) {
    // non-interactive: deny writes unless yolo was set (handled above)
    console.error(`[permission] denied (non-TTY): ${toolName}`);
    return false;
  }
  const preview =
    typeof detail === 'string'
      ? detail.slice(0, 400)
      : JSON.stringify(detail, null, 0).slice(0, 400);
  console.log(`\n${t.yellow(`  ${icons.pending}  permission`)}  ${t.bold(toolLabel(toolName))}`);
  console.log(t.dim(`  ${preview}`));
  console.log('');
  const picked = await selectMenu({
    options: [
      { label: 'Allow once', hint: 'run this operation', action: 'once', aliases: ['y', 'yes', 'allow'] },
      { label: 'Allow always', hint: 'all tools for this session', action: 'always', aliases: ['a'] },
      { label: 'Reject', hint: 'do not run', action: 'reject', aliases: ['n', 'no', 'deny'] },
    ],
    footer: '↑/↓ move  Enter select  Esc reject',
  });
  if (picked?.action === 'always') {
    const confirm = await selectMenu({
      title: 'allow all tools for this session?',
      subtitle: 'This setting lasts until the CLI exits.',
      options: [
        { label: 'Confirm allow always', action: 'confirm' },
        { label: 'Cancel', action: 'cancel' },
      ],
      initialIndex: 1,
      footer: '↑/↓ move  Enter select  Esc cancel',
    });
    return confirm?.action === 'confirm' ? 'always' : false;
  }
  return picked?.action === 'once';
}

function toolLabel(name) {
  return ({
    bash: 'Bash', write_file: 'Write', edit_file: 'Edit', list_dir: 'List',
    delete_file: 'Delete', move_file: 'Move', todo_write: 'Tasks',
    git: 'Git', web_fetch: 'Fetch', ask_question: 'Ask', task: 'Task',
    project_docs: 'Docs', research: 'Research', skill: 'Skill', mcp_manage: 'MCP', list_mcp_tools: 'MCP', call_mcp_tool: 'MCP',
  })[name] || name;
}
