/**
 * Terminal theme — monochrome UI (white / gray / black).
 * Keep green/red for diffs & success/error; blue/cyan OK for links and secondary meta.
 */

const colorEnabled = process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const style = (code, value) => colorEnabled ? `\x1b[${code}m${value}\x1b[0m` : String(value);

export const t = {
  reset: colorEnabled ? '\x1b[0m' : '',
  bold: (s) => style('1', s),
  dim: (s) => style('2', s),
  italic: (s) => style('3', s),
  inverse: (s) => style('7', s),
  // Functional colors (not UI chrome)
  cyan: (s) => style('36', s), // links / model meta (blue family OK)
  green: (s) => style('32', s), // success + diff additions
  red: (s) => style('31', s), // errors + diff deletions
  blue: (s) => style('34', s),
  // UI states mapped to grayscale (no warm apricot / bright yellow chrome)
  yellow: (s) => style('37', s), // was ANSI yellow — now light gray for busy/warning chrome
  magenta: (s) => style('37', s), // goal/agent labels → light gray
  white: (s) => style('97', s),
  bright: (s) => style('97', s),
  gray: (s) => style('90', s),
  // Primary chrome: white–gray only
  accent: (s) => style('97', s), // bright white (was 216 peach)
  accent2: (s) => style('38;5;245', s), // mid gray
  border: (s) => style('38;5;240', s), // dark gray frames
  user: (s) => style('38;5;255', s), // pure white user text
  agent: (s) => style('38;5;250', s), // near-white assistant text
  tool: (s) => style('38;5;245', s), // gray tool labels
};

export const icons = {
  bullet: '●',
  spin: '◐◓◑◒',
  check: '✓',
  cross: '✗',
  pending: '○',
  arrow: '❯',
  gear: '⚙',
  spark: '✦',
  branch: '⎇',
  lock: '▣',
  key: '◆',
  globe: '◎',
  chat: '◇',
};

export const VERSION = '0.3.5';
