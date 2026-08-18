import { t, icons } from '../ui/theme.js';
import { selectMenu } from '../ui/select.js';

const READ_TOOLS = new Set(['read_file', 'glob', 'grep']);

function isReadTool(toolName, sideEffect) {
  return sideEffect === 'none' || READ_TOOLS.has(toolName);
}

function isEditTool(toolName) {
  return toolName === 'write_file' || toolName === 'edit_file' || toolName === 'todo_write';
}

function autoApproved(mode, toolName, { allowTodo = false, toolResolver = null } = {}) {
  if (mode === 'yolo') return true;
  if (mode === 'strict') return false;
  if (allowTodo && toolName === 'todo_write') return true;
  const sideEffect = toolResolver?.(toolName)?.sideEffect;
  if (isReadTool(toolName, sideEffect)) return true;
  if (mode === 'accept-edits' && isEditTool(toolName)) return true;
  if (mode === 'auto' && READ_TOOLS.has(toolName)) return true;
  return false;
}

/**
 * @param {'ask'|'auto'|'accept-edits'|'yolo'|'strict'} mode
 */
export function createPermissionGate(mode = 'ask', requestApproval = null, {
  interactive,
  allowTodo = false,
  toolResolver = null,
} = {}) {
  const m = mode || 'ask';
  const canPrompt = interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  const opts = { allowTodo, toolResolver };

  return {
    mode: m,
    requiresApproval(toolName) {
      return !autoApproved(m, toolName, opts);
    },
    async approve(toolName, detail, { signal = null } = {}) {
      if (signal?.aborted) return false;
      if (autoApproved(m, toolName, opts)) return true;
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
  return ({ bash: 'Bash', write_file: 'Write', edit_file: 'Edit', todo_write: 'Tasks' })[name] || name;
}
