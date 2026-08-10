import { t, icons } from '../ui/theme.js';
import { selectMenu } from '../ui/select.js';

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'bash', 'todo_write']);
const READ_TOOLS = new Set(['read_file', 'glob', 'grep']);

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

  return {
    mode: m,
    requiresApproval(toolName) {
      if (m === 'yolo') return false;
      const sideEffect = toolResolver?.(toolName)?.sideEffect;
      if (sideEffect === 'none' || READ_TOOLS.has(toolName)) return false;
      if (allowTodo && toolName === 'todo_write') return false;
      if (m === 'accept-edits' && (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'todo_write')) {
        return false;
      }
      return true;
    },
    async approve(toolName, detail, { signal = null } = {}) {
      if (signal?.aborted) return false;
      if (m === 'yolo') return true;
      const sideEffect = toolResolver?.(toolName)?.sideEffect;
      if (sideEffect === 'none' || READ_TOOLS.has(toolName)) return true;
      if (allowTodo && toolName === 'todo_write') return true;
      if (m === 'accept-edits' && (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'todo_write')) {
        return true;
      }
      if (m === 'auto' && READ_TOOLS.has(toolName)) return true;
      // ask / auto for write tools
      if (!WRITE_TOOLS.has(toolName) && !READ_TOOLS.has(toolName)) {
        // unknown tools: ask unless yolo
        if (m === 'yolo') return true;
      }
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
