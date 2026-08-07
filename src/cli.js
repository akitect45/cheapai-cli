import { Command } from 'commander';
import { createClient, listModels } from './llm/client.js';
import { interactiveLogin, logout, whoami, openBrowser } from './auth.js';
import {
  loadConfig,
  saveConfig,
  resolveBaseUrl,
  resolveApiKey,
  loadAuth,
  DEFAULT_WEB_ORIGIN,
} from './config.js';
import { VERSION, t } from './ui/theme.js';
import { showAuthWelcome } from './ui/welcome.js';
import { runBrowserAuthFlow, runApiKeyAuthFlow } from './ui/device-auth.js';
import { startChatTui } from './ui/chat.js';

export async function main(argv = process.argv) {
  const program = new Command();
  program
    .name('cheapai')
    .description('CheapAI coding agent')
    .version(VERSION)
    .argument('[prompt...]', 'Optional initial prompt')
    .option('-p, --print', 'Headless one-shot', false)
    .option('-m, --model <model>', 'Model id')
    .option('-c, --continue', 'Continue latest session', false)
    .option('--resume <id>', 'Resume session by id')
    .option('--cwd <dir>', 'Working directory', process.cwd())
    .option('--yolo', 'Auto-approve tools', false)
    .option('--permission-mode <mode>', 'ask | auto | accept-edits | yolo')
    .option('--effort <level>', 'reasoning effort: low|medium|high|xhigh|off')
    .option('--max-turns <n>', 'Max tool loops', (v) => parseInt(v, 10))
    .option('--login', 'Force auth picker even if already signed in', false)
    .action(async (promptParts, opts) => {
      const prompt = promptParts.join(' ').trim();
      await boot({ prompt, opts });
    });

  program
    .command('login')
    .description('Sign in (then open chat on TTY)')
    .option('--key [apiKey]', 'API key mode')
    .option('--browser', 'Browser device code')
    .option('--no-chat', 'Only login')
    .option('--web-origin <url>', 'Web origin', DEFAULT_WEB_ORIGIN)
    .action(async (opts) => {
      try {
        restoreTty();
        let auth;
        if (opts.key !== undefined) {
          auth = await interactiveLogin({ key: opts.key === true ? true : opts.key });
        } else {
          auth = await runBrowserAuthFlow({ webOrigin: opts.webOrigin });
        }
        console.log(t.green(`✓ signed in as ${auth.username || 'api-key'}`));
        if (!opts.noChat && process.stdin.isTTY) {
          await enterChat({ prompt: '', opts: {} });
        }
      } catch (err) {
        console.error('✗', err.message || err);
        process.exitCode = 1;
      }
    });

  program.command('logout').action(() => {
    logout();
    console.log('✓ logged out');
  });

  program.command('whoami').action(() => {
    const info = whoami();
    if (!info.loggedIn) {
      console.log('not signed in');
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(info, null, 2));
  });

  program.command('models').action(async () => {
    try {
      const { client, baseURL } = createClient();
      const models = await listModels(client);
      console.log(`base: ${baseURL}`);
      for (const m of models) console.log(`- ${m.id}`);
    } catch (err) {
      // public list
      try {
        const base = resolveBaseUrl(loadConfig(), loadAuth());
        const res = await fetch(`${base}/models`);
        const data = await res.json();
        console.log(`base: ${base}`);
        for (const m of data.data || []) console.log(`- ${m.id}`);
      } catch (e2) {
        console.error('✗', err.message || err);
        process.exitCode = 1;
      }
    }
  });

  program
    .command('config')
    .option('--set <key=value>', 'Set config', collect, [])
    .action((opts) => {
      const cfg = loadConfig();
      for (const pair of opts.set || []) {
        const i = pair.indexOf('=');
        if (i < 0) continue;
        const k = pair.slice(0, i);
        let v = pair.slice(i + 1);
        if (v === 'true') v = true;
        else if (v === 'false') v = false;
        else if (/^\d+$/.test(v)) v = Number(v);
        cfg[k] = v;
      }
      if (opts.set?.length) {
        saveConfig(cfg);
        console.log('✓ saved');
      }
      console.log(JSON.stringify(cfg, null, 2));
    });

  program.command('dashboard').action(() => {
    openBrowser(`${(loadConfig().webOrigin || DEFAULT_WEB_ORIGIN).replace(/\/$/, '')}/api/dashboard`);
  });

  await program.parseAsync(argv);
}

function collect(value, prev) {
  prev.push(value);
  return prev;
}

function restoreTty() {
  try {
    if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
    process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?1002l\x1b[?25h');
  } catch {
    /* ignore */
  }
}

async function enterChat({ prompt, opts }) {
  restoreTty();
  if (!resolveApiKey()) throw new Error('not signed in');
  await startChatTui({ prompt, opts, print: !!opts?.print });
}

/**
 * Grok-like boot:
 * - signed in  → chat immediately (no welcome, no browser)
 * - not signed → auth picker only, then chat
 */
async function boot({ prompt, opts }) {
  if (opts.print) {
    if (!resolveApiKey()) {
      console.error('API key required for -p mode');
      process.exitCode = 1;
      return;
    }
    await startChatTui({ prompt, opts, print: true });
    return;
  }

  if (!process.stdin.isTTY) {
    if (!resolveApiKey()) {
      console.error('not a TTY and no API key');
      process.exitCode = 1;
      return;
    }
    await startChatTui({ prompt, opts, print: false });
    return;
  }

  try {
    restoreTty();

    // Already signed in → straight to chat (Grok behavior)
    if (resolveApiKey() && !opts.login) {
      await enterChat({ prompt, opts });
      return;
    }

    // Auth required
    while (true) {
      const w = await showAuthWelcome();
      if (w.action === 'exit') {
        console.log(t.dim('\n  bye.\n'));
        return;
      }
      if (w.action === 'login-browser') {
        await runBrowserAuthFlow();
      } else if (w.action === 'login-key') {
        await runApiKeyAuthFlow();
      } else {
        continue;
      }
      if (resolveApiKey()) {
        await enterChat({ prompt, opts });
        return;
      }
      console.log(t.yellow('  sign-in did not save a key — try again\n'));
    }
  } catch (err) {
    restoreTty();
    console.error(t.red(`\n✗ ${err.message || err}\n`));
    if (process.env.CHEAPAI_DEBUG) console.error(err.stack);
    process.exitCode = 1;
  }
}
