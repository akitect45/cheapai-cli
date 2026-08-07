import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { t, icons, VERSION } from './theme.js';
import {
  clearScreen,
  statusBar,
  hr,
  userBubble,
  thinkingLine,
  toolCard,
  footerHints,
  shortPath,
} from './draw.js';
import {
  createClient,
  listModels,
  persistModel,
  persistEffort,
} from '../llm/client.js';
import {
  loadConfig,
  resolveModel,
  resolveBaseUrl,
  loadAuth,
  saveConfig,
} from '../config.js';
import { whoami, logout, openBrowser } from '../auth.js';
import { buildSystemPrompt } from '../prompts/system.js';
import {
  createSession,
  loadSession,
  findLatestSession,
  saveSession,
} from '../agent/session.js';
import { runAgentLoop } from '../agent/loop.js';
import { DEFAULT_WEB_ORIGIN } from '../config.js';

/**
 * Grok-like interactive chat: authed users land here directly.
 * Slash commands actually change runtime state.
 */
export async function startChatTui({
  prompt = '',
  opts = {},
  print = false,
} = {}) {
  const cfg = loadConfig();
  const cwd = opts.cwd || process.cwd();
  process.chdir(cwd);

  let model = resolveModel(opts.model, cfg);
  let reasoningEffort = cfg.reasoningEffort || opts.effort || 'off';
  let permissionMode = opts.yolo
    ? 'yolo'
    : opts.permissionMode || cfg.permissionMode || 'ask';
  const maxTurns = opts.maxTurns || cfg.maxTurns || 40;
  let showThinking = cfg.showThinking !== false;
  const me = whoami();

  let { client } = createClient({ model });

  let session;
  if (opts.resume) {
    session = loadSession(opts.resume);
    if (!session) throw new Error(`세션 없음: ${opts.resume}`);
  } else if (opts.continue) {
    session = findLatestSession(cwd);
  }
  if (!session) {
    session = createSession({
      cwd,
      model,
      systemPrompt: buildSystemPrompt({ cwd, model }),
    });
    saveSession(session);
  } else {
    session.model = model;
  }

  const ui = createChatUi({
    model,
    mode: permissionMode,
    effort: reasoningEffort,
    cwd,
    user: me.username,
    sessionId: session.id,
    print,
  });

  function refreshClient() {
    ({ client } = createClient({ model }));
  }

  const runOnce = async (text) => {
    if (!print) ui.writeUser(text);
    const result = await runAgentLoop({
      client,
      model,
      session,
      userText: text,
      permissionMode,
      maxTurns,
      temperature: cfg.temperature ?? 0.2,
      reasoningEffort: reasoningEffort === 'off' ? null : reasoningEffort,
      showThinking,
      print,
      alwaysApprove: permissionMode === 'yolo',
      ui: print ? null : ui.agentHooks(),
    });
    if (!print && result.usage) ui.writeUsage(result.usage);
    return result;
  };

  if (print) {
    if (prompt) {
      await runOnce(prompt);
      return;
    }
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) throw new Error('빈 프롬프트');
    await runOnce(text);
    return;
  }

  // Clean terminal for readline chat
  restoreCookedTty();
  ui.mount();

  if (prompt) {
    await runOnce(prompt);
  }

  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    while (true) {
      ui.writePrompt();
      let line;
      try {
        line = (await rl.question('')).trim();
      } catch {
        console.log(t.dim('\n  (stdin closed)\n'));
        break;
      }
      if (!line) continue;

      // ── slash commands (Grok-style) ───────────────────────────
      if (line.startsWith('/')) {
        const handled = await handleSlash(line, {
          ui,
          session,
          get model() {
            return model;
          },
          set model(v) {
            model = v;
            session.model = v;
            ui.model = v;
            persistModel(v);
            // rebuild system prompt for new model label
            if (session.messages?.[0]?.role === 'system') {
              session.messages[0].content = buildSystemPrompt({ cwd, model });
            }
            refreshClient();
          },
          get effort() {
            return reasoningEffort;
          },
          set effort(v) {
            reasoningEffort = v;
            ui.effort = v;
            persistEffort(v);
          },
          get permissionMode() {
            return permissionMode;
          },
          set permissionMode(v) {
            permissionMode = v;
            ui.mode = v;
            const c = loadConfig();
            c.permissionMode = v;
            saveConfig(c);
          },
          get showThinking() {
            return showThinking;
          },
          set showThinking(v) {
            showThinking = v;
            const c = loadConfig();
            c.showThinking = v;
            saveConfig(c);
          },
          cwd,
          client,
          refreshClient,
          recreateSession: () => {
            session = createSession({
              cwd,
              model,
              systemPrompt: buildSystemPrompt({ cwd, model }),
            });
            saveSession(session);
            ui.sessionId = session.id;
            ui.mount(`new session ${session.id.slice(0, 8)}`);
          },
          rl,
        });
        if (handled === 'exit') break;
        if (handled === 'home') {
          // signal caller? for now just note — boot already skipped welcome when authed
          console.log(t.dim('  (already in chat · use /logout then restart to re-auth)'));
          continue;
        }
        if (handled) continue;
      }

      await runOnce(line);
    }
  } finally {
    rl.close();
  }
}

async function handleSlash(line, ctx) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  const c = cmd.toLowerCase();

  if (c === 'exit' || c === 'quit' || c === 'q') {
    console.log(t.dim('\n  bye.\n'));
    return 'exit';
  }

  if (c === 'help' || c === 'h' || c === '?') {
    printHelp();
    return true;
  }

  if (c === 'status' || c === 'session' || c === 'info' || c === 'session-info') {
    const me = whoami();
    console.log(`
  ${t.bold('session')}
  ${t.dim('version ')} ${VERSION}
  ${t.dim('user    ')} ${me.username || '—'}  ${me.apiKeyPreview || ''}
  ${t.dim('model   ')} ${ctx.model}
  ${t.dim('effort  ')} ${ctx.effort}
  ${t.dim('think   ')} ${ctx.showThinking ? 'on' : 'off'}
  ${t.dim('mode    ')} ${ctx.permissionMode}
  ${t.dim('session ')} ${ctx.session.id}
  ${t.dim('cwd     ')} ${ctx.cwd}
  ${t.dim('base    ')} ${resolveBaseUrl(loadConfig(), loadAuth())}
  ${t.dim('msgs    ')} ${ctx.session.messages?.length || 0}
`);
    return true;
  }

  if (c === 'clear' || c === 'new') {
    ctx.recreateSession();
    return true;
  }

  if (c === 'yolo' || c === 'always-approve') {
    ctx.permissionMode = ctx.permissionMode === 'yolo' ? 'ask' : 'yolo';
    console.log(t.yellow(`\n  permission → ${ctx.permissionMode}\n`));
    return true;
  }

  if (c === 'ask') {
    ctx.permissionMode = 'ask';
    console.log(t.dim('\n  permission → ask\n'));
    return true;
  }

  if (c === 'accept-edits') {
    ctx.permissionMode = 'accept-edits';
    console.log(t.dim('\n  permission → accept-edits\n'));
    return true;
  }

  // /model  or  /model <id>  or  /m
  if (c === 'model' || c === 'm') {
    if (!arg) {
      try {
        const models = await listModels(ctx.client);
        console.log(`\n  ${t.bold('models')}  ${t.dim('(current: ' + ctx.model + ')')}\n`);
        for (const m of models.slice(0, 40)) {
          const mark = m.id === ctx.model ? t.accent('❯') : ' ';
          console.log(`  ${mark} ${m.id}${m.owned_by ? t.dim('  ' + m.owned_by) : ''}`);
        }
        console.log(t.dim('\n  usage: /model <id>\n'));
      } catch (e) {
        console.log(t.red(`  failed to list models: ${e.message}`));
        console.log(t.dim('  usage: /model claude-sonnet-5\n'));
      }
      return true;
    }
    ctx.model = arg;
    console.log(t.cyan(`\n  model → ${arg}  ${t.dim('(saved)')}\n`));
    return true;
  }

  // /effort  /thinking  /think
  if (c === 'effort' || c === 'thinking' || c === 'think') {
    if (!arg) {
      console.log(`
  ${t.bold('reasoning effort')}  current: ${t.accent(ctx.effort)}
  ${t.dim('usage:')} /effort low|medium|high|xhigh|off
  ${t.dim('alias:')} /thinking  /think
`);
      return true;
    }
    const v = arg.toLowerCase();
    const allowed = ['low', 'medium', 'high', 'xhigh', 'max', 'off', 'none'];
    if (!allowed.includes(v)) {
      console.log(t.red(`  invalid: ${arg}  (low|medium|high|xhigh|off)`));
      return true;
    }
    ctx.effort = v === 'none' ? 'off' : v === 'max' ? 'xhigh' : v;
    console.log(t.cyan(`\n  effort → ${ctx.effort}  ${t.dim('(saved)')}\n`));
    return true;
  }

  if (c === 'think-show' || c === 'show-thinking') {
    ctx.showThinking = !ctx.showThinking;
    console.log(t.dim(`\n  show thinking → ${ctx.showThinking ? 'on' : 'off'}\n`));
    return true;
  }

  if (c === 'logout') {
    logout();
    console.log(t.yellow('\n  logged out. restart `cheapai` to sign in again.\n'));
    return 'exit';
  }

  if (c === 'home' || c === 'welcome') {
    return 'home';
  }

  if (c === 'dashboard') {
    const origin = loadConfig().webOrigin || DEFAULT_WEB_ORIGIN;
    openBrowser(`${origin.replace(/\/$/, '')}/api/dashboard`);
    console.log(t.dim('  opened dashboard\n'));
    return true;
  }

  if (c === 'config') {
    console.log('\n' + JSON.stringify(loadConfig(), null, 2) + '\n');
    return true;
  }

  console.log(t.yellow(`  unknown command: /${cmd}  ${t.dim('try /help')}\n`));
  return true;
}

function printHelp() {
  console.log(`
  ${t.bold('commands')}  ${t.dim('(Grok-style)')}
  ${t.dim('─'.repeat(42))}
  /help                 this help
  /status               session + auth info
  /model [id]           list or switch model
  /effort [level]       reasoning: low|medium|high|xhigh|off
  /thinking [level]     alias of /effort
  /think-show           toggle streaming thoughts display
  /yolo                 toggle auto-approve tools
  /ask                  require tool approval
  /accept-edits         auto file edits
  /new  /clear          new session
  /dashboard            open cheapai.im dashboard
  /config               show local config
  /logout               clear credentials & exit
  /exit                 quit
`);
}

function restoreCookedTty() {
  try {
    if (input.isTTY && input.setRawMode) input.setRawMode(false);
    process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?1002l\x1b[?25h');
  } catch {
    /* ignore */
  }
}

function createChatUi({ model, mode, effort, cwd, user, sessionId, print }) {
  const state = { model, mode, effort, cwd, user, sessionId, print };

  function mount(notice) {
    clearScreen();
    console.log('');
    console.log(
      '  ' +
        statusBar({
          model: state.model,
          mode: state.mode,
          cwd: state.cwd,
          user: state.user,
          session: state.sessionId,
        }) +
        t.dim(`  ·  effort ${state.effort || 'off'}`),
    );
    console.log(hr('─'));
    console.log('');
    console.log(t.dim(`  ${icons.spark} CheapAI Agent  ·  type a message or /help`));
    console.log(t.dim(`  ${shortPath(state.cwd)}`));
    if (notice) console.log(t.accent(`  ${notice}`));
    console.log('');
    console.log(footerHints(['/model', '/effort']));
    console.log('');
  }

  function writeUser(text) {
    console.log(userBubble(text));
  }

  function writePrompt() {
    process.stdout.write(t.accent(`\n  ${icons.arrow} `));
  }

  function writeUsage(usage) {
    if (!usage) return;
    console.log(
      t.dim(
        `  tokens  in ${usage.prompt_tokens || 0}  out ${usage.completion_tokens || 0}`,
      ),
    );
  }

  function agentHooks() {
    return {
      onThinking(turn) {
        console.log(thinkingLine(turn));
      },
      onReasoningDelta(text) {
        process.stdout.write(t.dim(text));
      },
      onDelta(text) {
        process.stdout.write(t.agent(text));
      },
      onAssistantStart() {
        console.log(t.accent('\n  ✦ cheapai\n'));
      },
      onAssistantEnd() {
        process.stdout.write('\n');
      },
      onToolStart(name, detail) {
        console.log('\n' + toolCard(name, detail, 'running'));
      },
      onToolEnd(name, _detail, status) {
        const st =
          status === 'ok'
            ? t.green(`  ${icons.check} ${name}`)
            : status === 'denied'
              ? t.red(`  ${icons.cross} ${name} denied`)
              : t.yellow(`  · ${name}`);
        console.log(st);
      },
    };
  }

  return {
    get model() {
      return state.model;
    },
    set model(v) {
      state.model = v;
    },
    get mode() {
      return state.mode;
    },
    set mode(v) {
      state.mode = v;
    },
    get effort() {
      return state.effort;
    },
    set effort(v) {
      state.effort = v;
    },
    set sessionId(v) {
      state.sessionId = v;
    },
    mount,
    writeUser,
    writePrompt,
    writeUsage,
    agentHooks,
  };
}
