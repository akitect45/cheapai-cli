import { TOOL_DEFINITIONS } from './tools.js';
import { createAgentRuntime } from './runtime.js';

const GOAL_TOOL_NAMES = new Set(['read_file', 'glob', 'grep', 'todo_write']);

export function toolsForMode(goalMode = false) {
  return goalMode
    ? TOOL_DEFINITIONS.filter((tool) => GOAL_TOOL_NAMES.has(tool.function.name))
    : TOOL_DEFINITIONS;
}

/**
 * Compatibility facade for the original callback-based agent loop.
 * The runtime owns lifecycle, events, queues, validation, and side effects.
 */
export async function runAgentLoop(options = {}) {
  const runtime = createAgentRuntime(options);
  return runtime.run(options.userContent ?? options.userText);
}

export { createAgentRuntime } from './runtime.js';
