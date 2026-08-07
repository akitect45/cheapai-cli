import { t, VERSION } from './theme.js';
import { termWidth } from './draw.js';
import { whoami } from '../auth.js';
import { resolveBaseUrl, loadConfig, loadAuth } from '../config.js';
import { selectMenu } from './select.js';

/** Auth-only welcome shown before the first coding session. */
export async function showAuthWelcome() {
  const cfg = loadConfig();
  const base = resolveBaseUrl(cfg, loadAuth());
  const logo = termWidth() >= 48
    ? [
        `${t.accent('█▀▀ █ █ █▀▀ ▄▀█ █▀█')} ${t.gray('  ▄▀█ █')}`,
        `${t.accent('█▄▄ █▀█ ██▄ █▀█ █▀▀')} ${t.gray('  █▀█ █')}`,
      ]
    : [t.bold(t.accent('cheap')) + t.bold(t.gray('ai'))];

  const picked = await selectMenu({
    headerLines: [
      ...logo,
      '',
      t.bold(t.white('Your AI coding workspace')),
      t.dim(`v${VERSION}  ·  credentials stay on this machine`),
      t.dim(base),
    ],
    centered: true,
    alternateScreen: true,
    initialIndex: 0,
    options: [
      {
        id: 'login-browser',
        label: 'Continue in browser',
        hint: 'recommended · device code',
        action: 'login-browser',
      },
      {
        id: 'login-key',
        label: 'Use an API key',
        hint: 'manual setup',
        action: 'login-key',
      },
      {
        id: 'exit',
        label: 'Quit',
        hint: '',
        action: 'exit',
      },
    ],
  });

  if (!picked) return { action: 'exit' };
  return { action: picked.action };
}

/** @deprecated use showAuthWelcome — kept for imports */
export async function showWelcome() {
  const info = whoami();
  if (info.loggedIn) {
    return { action: 'chat', alreadyAuthed: true };
  }
  return showAuthWelcome();
}

export async function showAuthMenu() {
  return showAuthWelcome();
}
