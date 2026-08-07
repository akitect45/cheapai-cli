/** Grok Build–inspired terminal theme (dark, compact, tool cards) */

export const t = {
  reset: '\x1b[0m',
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  italic: (s) => `\x1b[3m${s}\x1b[0m`,
  // accents
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  white: (s) => `\x1b[97m${s}\x1b[0m`,
  // alias used by select menu
  bright: (s) => `\x1b[97m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
  // grok-ish warm accent (xAI green-ish on many themes)
  accent: (s) => `\x1b[38;5;114m${s}\x1b[0m`,
  accent2: (s) => `\x1b[38;5;80m${s}\x1b[0m`,
  border: (s) => `\x1b[38;5;240m${s}\x1b[0m`,
  user: (s) => `\x1b[38;5;117m${s}\x1b[0m`,
  agent: (s) => `\x1b[38;5;252m${s}\x1b[0m`,
  tool: (s) => `\x1b[38;5;178m${s}\x1b[0m`,
};

export const icons = {
  bullet: '●',
  spin: '◐◓◑◒',
  check: '✓',
  cross: '✗',
  arrow: '❯',
  gear: '⚙',
  spark: '✦',
  branch: '⎇',
  lock: '🔒',
  key: '🔑',
  globe: '🌐',
  chat: '💬',
};

export const VERSION = '0.3.0';
