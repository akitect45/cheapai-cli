import { Command } from 'commander';
import { createClient, fetchAccountUsage, listModels } from './llm/client.js';
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
import { accountUsageRows } from './agent/usage.js';
import {
  deleteSession,
  exportSessionData,
  findLatestSession,
  forkSession,
  importSessionData,
  listAllSessions,
  loadSession,
  sessionStats,
} from './agent/session.js';
import fs from 'node:fs';
import path from 'node:path';
import { loadCustomAgents } from './agent/commands.js';
import { checkForUpdate, installLatestVersion } from './update.js';

function configureStdio() {
  try {
    process.stdout.setDefaultEncoding?.('utf8');
    process.stderr.setDefaultEncoding?.('utf8');
  } catch {
    /* ignore */
  }
}

export async function main(argv = process.argv) {
  configureStdio();
  const args = argv.slice(2);
  const command = args[0];
  const skipUpdateCheck = args.includes('--help')
    || args.includes('-h')
    || args.includes('--version')
    || args.includes('-V')
    || args.includes('--json')
    || args.includes('--print')
    || args.includes('-p')
    || ['login', 'logout', 'whoami', 'models', 'usage', 'stats', 'session', 'agent', 'export', 'import', 'credits', 'config', 'dashboard'].includes(command);
  if (args.includes('--update')) {
    console.log('Checking for updates...');
    const result = await installLatestVersion();
    console.log(`\n${result.message}\n`);
    return;
  }

  // Never block TUI boot on the registry. A hung npm check used to leave
  // "업데이트 있음" on screen with no follow-up work.
  const updateInfoPromise = skipUpdateCheck ? Promise.resolve(null) : checkForUpdate();
  const program = new Command();
  program
    .name('cheapai')
    .description('CheapAI coding agent')
    .version(VERSION)
    .option('--update', 'Update CheapAI to the latest published version')
    .argument('[prompt...]', 'Optional initial prompt')
    .option('-p, --print', 'Headless one-shot', false)
    .option('-m, --model <model>', 'Model id')
    .option('-c, --continue', 'Continue latest session', false)
    .option('--resume <id>', 'Resume session by id')
    .option('--fork', 'Fork the resumed or latest session before continuing', false)
    .option('--title <title>', 'Set the session title')
    .option('--agent <name>', 'Agent profile')
    .option('--cwd <dir>', 'Working directory', process.cwd())
    .option('--yolo', 'Auto-approve tools', false)
    .option('--permission-mode <mode>', 'ask | auto | accept-edits | yolo')
    .option('--effort <level>', 'reasoning effort: low|medium|high|xhigh|off')
    .option('--max-turns <n>', 'Max tool loops', (v) => parseInt(v, 10))
    .option('--no-auto-compact', 'Disable automatic context compaction')
    .option('--login', 'Force auth picker even if already signed in', false)
    .action(async (promptParts, opts) => {
      const prompt = promptParts.join(' ').trim();
      await boot({ prompt, opts: { ...opts, updateInfoPromise } });
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
        if (!opts.noChat && process.stdin.isTTY && process.stdout.isTTY) {
          await enterChat({ prompt: '', opts: {} });
        }
      } catch (err) {
        console.error('✗', err.message || err);
        process.exitCode = 1;
      }
    });

  program.command('logout').action(() => {
    const result = logout();
    if (result.loggedOut) console.log('✓ logged out');
    else console.log(`auth.json cleared; still signed in via ${result.source}`);
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

  program
    .command('models')
    .option('--verbose', 'Show context and pricing metadata', false)
    .option('--json', 'Print JSON', false)
    .action(async (opts) => {
    try {
      const { client, baseURL } = createClient();
      const models = await listModels(client);
      if (opts.json) {
        console.log(JSON.stringify(models, null, 2));
        return;
      }
      console.log(`base: ${baseURL}`);
      for (const m of models) {
        const context = m.context_window || m.contextWindow || m.max_tokens;
        const pricing = m.pricing ? `  in ${m.pricing.input ?? m.pricing.prompt}/out ${m.pricing.output ?? m.pricing.completion}` : '';
        console.log(`- ${m.id}${opts.verbose ? `  context ${context || '—'}${pricing}` : ''}`);
      }
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

  const runCommand = program.command('run [prompt...]').description('Run a prompt in the coding workspace');
  runCommand
    .option('-p, --print', 'Headless one-shot', false)
    .option('-m, --model <model>', 'Model id')
    .option('-c, --continue', 'Continue latest session', false)
    .option('--resume <id>', 'Resume session by id')
    .option('--fork', 'Fork the resumed or latest session', false)
    .option('--title <title>', 'Set the session title')
    .option('--agent <name>', 'Agent profile')
    .option('--cwd <dir>', 'Working directory', process.cwd())
    .option('--yolo', 'Auto-approve tools', false)
    .option('--permission-mode <mode>', 'ask | auto | accept-edits | yolo')
    .option('--effort <level>', 'reasoning effort: low|medium|high|xhigh|off')
    .option('--max-turns <n>', 'Max tool loops', (value) => Number(value))
    .option('--no-auto-compact', 'Disable automatic context compaction')
    .action(async (promptParts, opts) => {
      await boot({ prompt: promptParts.join(' ').trim(), opts: { ...opts, updateInfoPromise } });
    });

  program
    .command('usage')
    .description('Show account credits and recent API usage')
    .option('--json', 'Print raw JSON', false)
    .action(async (opts) => printAccountUsage(opts));

  program
    .command('stats')
    .description('Show local session, token, model, and tool statistics')
    .option('--days <n>', 'Only sessions updated in the last N days', (value) => Number(value))
    .option('--project [dir]', 'Filter by workspace (defaults to current directory)')
    .option('--json', 'Print JSON', false)
    .option('--format <format>', 'Output format', 'table')
    .action((opts) => printLocalStats(opts));

  const sessionCommand = program.command('session').description('Manage local sessions');
  sessionCommand
    .command('list')
    .description('List sessions')
    .option('-n, --max-count <n>', 'Limit results', (value) => Number(value), 20)
    .option('--project [dir]', 'Filter by workspace (defaults to current directory)')
    .option('--json', 'Print JSON', false)
    .option('--format <format>', 'Output format', 'table')
    .action((opts) => printSessions(opts));
  sessionCommand
    .command('delete <id>')
    .description('Delete a session')
    .action((id) => {
      if (!deleteSession(id)) throw new Error(`Session not found: ${id}`);
      console.log(`✓ deleted ${id}`);
    });
  sessionCommand
    .command('fork <id>')
    .description('Fork a session')
    .option('--title <title>', 'Title for the fork')
    .action((id, opts) => {
      const source = loadSession(id);
      if (!source) throw new Error(`Session not found: ${id}`);
      const fork = forkSession(source, { title: opts.title });
      console.log(fork.id);
    });

  const agentCommand = program.command('agent').description('Manage project agent profiles');
  agentCommand
    .command('list')
    .description('List available agents')
    .option('--cwd <dir>', 'Project directory', process.cwd())
    .option('--json', 'Print JSON', false)
    .action((opts) => {
      const agents = [{ name: 'build', description: 'default coding agent' }, ...loadCustomAgents(opts.cwd)];
      if (opts.json) console.log(JSON.stringify(agents, null, 2));
      else for (const agent of agents) console.log(`${agent.name.padEnd(18)} ${agent.description}`);
    });

  program
    .command('export [sessionId]')
    .description('Export a session as JSON')
    .option('-o, --output <file>', 'Write to a file instead of stdout')
    .option('--sanitize', 'Redact tool output and undo snapshots', false)
    .action((sessionId, opts) => exportSessionCommand(sessionId, opts));

  program
    .command('import <file>')
    .description('Import a CheapAI session JSON file')
    .option('--cwd <dir>', 'Override imported workspace')
    .action(async (file, opts) => importSessionCommand(file, opts));

  program
    .command('credits')
    .description('Show remaining CheapAI credits')
    .option('--json', 'Print raw JSON', false)
    .action(async (opts) => printAccountUsage(opts));

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

async function printAccountUsage(opts = {}) {
  try {
    const { baseURL, apiKey } = createClient();
    const usage = await fetchAccountUsage({ baseURL, apiKey });
    if (opts.json) {
      console.log(JSON.stringify(usage, null, 2));
      return;
    }
    console.log('CheapAI usage');
    for (const [key, value] of accountUsageRows(usage)) {
      console.log(`  ${String(key).padEnd(14)} ${value}`);
    }
  } catch (error) {
    console.error('✗', error.message || error);
    process.exitCode = 1;
  }
}

function filteredSessions(opts = {}) {
  let sessions = listAllSessions();
  if (opts.project !== undefined) {
    const target = path.resolve(typeof opts.project === 'string' ? opts.project : process.cwd());
    sessions = sessions.filter((session) => path.resolve(session.cwd || '') === target);
  }
  if (Number(opts.days) > 0) {
    const after = Date.now() - Number(opts.days) * 86_400_000;
    sessions = sessions.filter((session) => new Date(session.updatedAt || 0).getTime() >= after);
  }
  return sessions;
}

function printSessions(opts = {}) {
  const sessions = filteredSessions(opts).slice(0, Math.max(1, Number(opts.maxCount) || 20));
  if (opts.json || opts.format === 'json') {
    console.log(JSON.stringify(sessions.map(sessionSummary), null, 2));
    return;
  }
  if (!sessions.length) {
    console.log('No sessions.');
    return;
  }
  console.log('ID        Updated           Model                 Title');
  for (const session of sessions) {
    const updated = new Date(session.updatedAt || session.createdAt || 0).toLocaleString();
    console.log(`${session.id.slice(0, 8).padEnd(10)}${updated.slice(0, 17).padEnd(18)}${String(session.model || '—').slice(0, 20).padEnd(22)}${session.title || 'Untitled session'}`);
  }
}

function sessionSummary(session) {
  return {
    id: session.id,
    parentId: session.parentId || null,
    cwd: session.cwd,
    model: session.model,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: Math.max(0, (session.messages || []).length - 1),
    usage: session.usage || {},
    compactions: session.compactions?.length || 0,
  };
}

function printLocalStats(opts = {}) {
  const stats = sessionStats(filteredSessions(opts));
  if (opts.json || opts.format === 'json') {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  console.log('CheapAI local stats');
  console.log(`  sessions       ${stats.sessions}`);
  console.log(`  messages       ${stats.messages}`);
  console.log(`  tokens         ${stats.totalTokens.toLocaleString()}`);
  console.log(`  input / output ${stats.inputTokens.toLocaleString()} / ${stats.outputTokens.toLocaleString()}`);
  console.log(`  billed         ₩${stats.credits.toLocaleString()}`);
  console.log(`  compactions    ${stats.compactions}`);
  const models = Object.entries(stats.models).sort((a, b) => b[1] - a[1]);
  if (models.length) console.log(`  models         ${models.map(([name, count]) => `${name} ${count}`).join(', ')}`);
  const tools = Object.entries(stats.tools).sort((a, b) => b[1] - a[1]);
  if (tools.length) console.log(`  tools          ${tools.map(([name, count]) => `${name} ${count}`).join(', ')}`);
}

function exportSessionCommand(sessionId, opts = {}) {
  const session = sessionId ? loadSession(sessionId) : findLatestSession(process.cwd());
  if (!session) throw new Error(sessionId ? `Session not found: ${sessionId}` : 'No session for this workspace.');
  const json = `${JSON.stringify(exportSessionData(session, { sanitize: opts.sanitize }), null, 2)}\n`;
  if (!opts.output) {
    process.stdout.write(json);
    return;
  }
  const destination = path.resolve(opts.output);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, json, 'utf8');
  console.log(`✓ exported ${destination}`);
}

async function importSessionCommand(file, opts = {}) {
  let text;
  if (/^https?:\/\//i.test(file)) {
    const response = await fetch(file);
    if (!response.ok) throw new Error(`Import failed (${response.status})`);
    text = await response.text();
  } else {
    text = fs.readFileSync(path.resolve(file), 'utf8');
  }
  const session = importSessionData(JSON.parse(text), { cwd: opts.cwd || process.cwd() });
  console.log(session.id);
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
 * Direct-to-workspace boot:
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

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (!resolveApiKey()) {
      console.error('not a TTY and no API key');
      process.exitCode = 1;
      return;
    }
    if (!prompt && process.stdin.isTTY) {
      console.error('interactive input requires a TTY stdout; pass a prompt or use --print');
      process.exitCode = 1;
      return;
    }
    await startChatTui({ prompt, opts, print: true });
    return;
  }

  try {
    restoreTty();

    // Already signed in -> straight to chat.
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
