import { t, icons, VERSION } from './theme.js';
import { clearScreen, bannerLogo, hr } from './draw.js';
import { whoami } from '../auth.js';
import { resolveBaseUrl, loadConfig, loadAuth } from '../config.js';
import { selectMenu } from './select.js';

/**
 * Auth-only welcome (shown when NOT logged in).
 * Grok: first launch = auth; later launches skip this and go to chat.
 */
export async function showAuthWelcome() {
  clearScreen();
  const cfg = loadConfig();
  const base = resolveBaseUrl(cfg, loadAuth());

  console.log('');
  console.log(bannerLogo());
  console.log('');
  console.log(t.dim(`  CheapAI Agent  v${VERSION}`));
  console.log(t.dim(`  ${base}`));
  console.log('');
  console.log(hr('·'));
  console.log('');
  console.log(t.bold('  Sign in to continue'));
  console.log(t.dim('  Connect this CLI to your CheapAI account.'));
  console.log('');

  const picked = await selectMenu({
    title: null,
    subtitle: null,
    initialIndex: 0,
    options: [
      {
        id: 'login-browser',
        label: 'Log in with browser',
        hint: 'device code on cheapai.im',
        action: 'login-browser',
      },
      {
        id: 'login-key',
        label: 'Log in with API key',
        hint: 'paste csk_…',
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
