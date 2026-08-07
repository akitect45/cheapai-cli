/** Semantic terminal theme inspired by focused, editorial coding tools. */

const colorEnabled = process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const style = (code, value) => colorEnabled ? `\x1b[${code}m${value}\x1b[0m` : String(value);

export const t = {
  reset: colorEnabled ? '\x1b[0m' : '',
  bold: (s) => style('1', s),
  dim: (s) => style('2', s),
  italic: (s) => style('3', s),
  inverse: (s) => style('7', s),
  // accents
  cyan: (s) => style('36', s),
  green: (s) => style('32', s),
  yellow: (s) => style('33', s),
  red: (s) => style('31', s),
  magenta: (s) => style('35', s),
  blue: (s) => style('34', s),
  white: (s) => style('97', s),
  // alias used by select menu
  bright: (s) => style('97', s),
  gray: (s) => style('90', s),
  // Warm primary plus cool tool metadata, close to modern coding TUIs.
  accent: (s) => style('38;5;216', s),
  accent2: (s) => style('38;5;117', s),
  border: (s) => style('38;5;238', s),
  user: (s) => style('38;5;216', s),
  agent: (s) => style('38;5;252', s),
  tool: (s) => style('38;5;110', s),
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

export const VERSION = '0.3.0';
