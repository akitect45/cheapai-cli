import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'bash', 'todo_write']);
const READ_TOOLS = new Set(['read_file', 'glob', 'grep']);

/**
 * @param {'ask'|'auto'|'accept-edits'|'yolo'} mode
 */
export function createPermissionGate(mode = 'ask') {
  const m = mode || 'ask';

  return {
    mode: m,
    async approve(toolName, detail) {
      if (m === 'yolo') return true;
      if (READ_TOOLS.has(toolName)) return true;
      if (m === 'accept-edits' && (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'todo_write')) {
        return true;
      }
      if (m === 'auto' && READ_TOOLS.has(toolName)) return true;
      // ask / auto for write tools
      if (!WRITE_TOOLS.has(toolName) && !READ_TOOLS.has(toolName)) {
        // unknown tools: ask unless yolo
        if (m === 'yolo') return true;
      }
      return askUser(toolName, detail);
    },
  };
}

async function askUser(toolName, detail) {
  if (!process.stdin.isTTY) {
    // non-interactive: deny writes unless yolo was set (handled above)
    console.error(`[permission] denied (non-TTY): ${toolName}`);
    return false;
  }
  const rl = readline.createInterface({ input, output });
  try {
    const preview =
      typeof detail === 'string'
        ? detail.slice(0, 400)
        : JSON.stringify(detail, null, 0).slice(0, 400);
    const ans = (
      await rl.question(`\n⚠ 도구 허용? ${toolName}\n   ${preview}\n   [y]es / [n]o / [a]lways(this session yolo): `)
    )
      .trim()
      .toLowerCase();
    if (ans === 'a' || ans === 'always') {
      // caller can detect by returning 'always'
      return 'always';
    }
    return ans === 'y' || ans === 'yes' || ans === '';
  } finally {
    rl.close();
  }
}
