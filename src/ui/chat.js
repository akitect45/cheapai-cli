import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { t, icons, VERSION } from './theme.js';
import {
  clearScreen,
  statusBar,
  termWidth,
  displayWidth,
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
  listSessions,
  saveSession,
} from '../agent/session.js';
import { runAgentLoop } from '../agent/loop.js';
import { DEFAULT_WEB_ORIGIN } from '../config.js';
import { selectMenu } from './select.js';
import { createFullscreenChatUi } from './fullscreen.js';

/**
 * Append-only interactive chat for a focused coding workspace.
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
  let reasoningEffort = opts.effort || cfg.reasoningEffort || 'off';
  let permissionMode = opts.yolo
    ? 'yolo'
    : opts.permissionMode || cfg.permissionMode || 'ask';
  const maxTurns = opts.maxTurns || cfg.maxTurns || 40;
  let showThinking = cfg.showThinking !== false;
  let showToolDetails = false;
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

  const fullscreen = !print && input.isTTY && output.isTTY;
  const ui = fullscreen ? createFullscreenChatUi({
    model,
    mode: permissionMode,
    effort: reasoningEffort,
    cwd,
    user: me.username,
    sessionId: session.id,
    sessionTitle: session.title,
    showThinking,
    messages: session.messages,
  }) : createChatUi({
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
      onPermissionModeChange: (mode) => {
        permissionMode = mode;
        ui.mode = mode;
        ui.writeContext('all tools allowed until exit');
      },
      requestPermission: ui.requestPermission || null,
      ui: print ? null : ui.agentHooks(),
    });
    if (!print && result.usage) ui.writeUsage(result.usage);
    if (!print) ui.sessionTitle = session.title;
    ui.setBusy?.(false);
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

  if (fullscreen) {
    try {
      ui.mount();
      if (prompt) {
        try {
          await runOnce(prompt);
        } catch (error) {
          ui.addNotice(error.message || String(error), 'error');
          ui.setBusy(false);
        }
      }
      while (true) {
        const line = (await ui.readInput()).trim();
        if (!line) continue;
        if (line.startsWith('/')) {
          const handled = await handleSlash(line, createSlashContext());
          if (handled === 'exit') break;
          if (handled) continue;
        }
        ui.setBusy(true);
        try {
          await runOnce(line);
        } catch (error) {
          ui.addNotice(error.message || String(error), 'error');
          ui.setBusy(false);
        }
      }
    } finally {
      ui.destroy();
    }
    return;
  }

  // Append-only fallback for terminals without full-screen capabilities.
  restoreCookedTty();
  ui.mount();

  if (prompt) {
    await runOnce(prompt);
  }

  let history = [];
  while (true) {
    const rl = readline.createInterface({ input, output, terminal: true, history });
    let line;
    try {
      ui.writePrompt();
      line = (await rl.question('')).trim();
      history = rl.history;
    } catch {
      console.log(t.dim('\n  (stdin closed)\n'));
      rl.close();
      break;
    }
    rl.close();
    if (!line) continue;

    // Slash commands keep the main input fast and keyboard-first.
    if (line.startsWith('/')) {
      const handled = await handleSlash(line, createSlashContext());
      if (handled === 'exit') break;
      if (handled === 'home') {
        console.log(t.dim('  (already in chat · use /logout then restart to re-auth)'));
        continue;
      }
      if (handled) continue;
    }

    await runOnce(line);
  }

  function createSlashContext() {
    return {
      ui,
      session,
      get model() {
        return model;
      },
      set model(value) {
        model = value;
        session.model = value;
        ui.model = value;
        persistModel(value);
        if (session.messages?.[0]?.role === 'system') {
          session.messages[0].content = buildSystemPrompt({ cwd, model });
        }
        refreshClient();
        ui.writeContext('model updated');
      },
      get effort() {
        return reasoningEffort;
      },
      set effort(value) {
        reasoningEffort = value;
        ui.effort = value;
        persistEffort(value);
        ui.writeContext('reasoning updated');
      },
      get permissionMode() {
        return permissionMode;
      },
      set permissionMode(value) {
        permissionMode = value;
        ui.mode = value;
        const config = loadConfig();
        config.permissionMode = value;
        saveConfig(config);
        ui.writeContext('permission updated');
      },
      get showThinking() {
        return showThinking;
      },
      set showThinking(value) {
        showThinking = value;
        ui.setThinkingVisible?.(value);
        const config = loadConfig();
        config.showThinking = value;
        saveConfig(config);
      },
      cwd,
      get client() {
        return client;
      },
      recreateSession() {
        session = createSession({
          cwd,
          model,
          systemPrompt: buildSystemPrompt({ cwd, model }),
        });
        saveSession(session);
        ui.sessionId = session.id;
        ui.sessionTitle = '';
        if (ui.resetSession) ui.resetSession(session.id, '', `new session ${session.id.slice(0, 8)}`, session.messages);
        else ui.mount(`new session ${session.id.slice(0, 8)}`);
      },
      toggleToolDetails() {
        showToolDetails = !showToolDetails;
        ui.setToolDetails(showToolDetails);
        ui.writeContext(`tool details ${showToolDetails ? 'on' : 'off'}`);
      },
      resumeSession(id) {
        const next = loadSession(id);
        if (!next) {
          ui.addNotice?.(`session not found: ${id}`, 'error');
          return;
        }
        session = next;
        model = next.model || model;
        ui.model = model;
        ui.sessionId = next.id;
        ui.sessionTitle = next.title || '';
        refreshClient();
        if (ui.resetSession) ui.resetSession(next.id, next.title || '', `resumed ${next.title || next.id.slice(0, 8)}`, next.messages);
        else ui.mount(`resumed ${next.title || next.id.slice(0, 8)}`);
      },
    };
  }
}

async function handleSlash(line, ctx) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  const c = cmd.toLowerCase();

  if (c === 'exit' || c === 'quit' || c === 'q') {
    return 'exit';
  }

  if (c === 'help' || c === 'h' || c === '?') {
    showHelp(ctx);
    return true;
  }

  if (c === 'details') {
    ctx.toggleToolDetails();
    return true;
  }

  if (c === 'sessions' || c === 'resume') {
    const sessions = listSessions(ctx.cwd).slice(0, 12);
    if (!sessions.length) {
      notify(ctx, 'No saved sessions for this workspace.');
      return true;
    }
    const options = sessions.map((item) => ({
      label: (item.title || 'Untitled session').slice(0, 58),
      hint: `${item.id.slice(0, 8)}  ·  ${formatSessionDate(item.updatedAt)}`,
      action: item.id,
    }));
    const picked = await pickOptions(ctx, {
      title: 'sessions',
      subtitle: ctx.cwd,
      options,
      initialIndex: Math.max(0, sessions.findIndex((item) => item.id === ctx.session.id)),
      footer: '↑/↓ move  Enter resume  Esc cancel',
    });
    if (picked) ctx.resumeSession(picked.action ?? picked);
    return true;
  }

  if (c === 'status' || c === 'session' || c === 'info' || c === 'session-info') {
    const me = whoami();
    showInfo(ctx, 'Session', [
      ['version', VERSION],
      ['user', me.username || '—'],
      ['model', ctx.model],
      ['effort', ctx.effort],
      ['thinking', ctx.showThinking ? 'visible' : 'hidden'],
      ['permission', ctx.permissionMode],
      ['session', ctx.session.id],
      ['workspace', ctx.cwd],
      ['base URL', resolveBaseUrl(loadConfig(), loadAuth())],
      ['messages', ctx.session.messages?.length || 0],
    ]);
    return true;
  }

  if (c === 'clear' || c === 'new') {
    ctx.recreateSession();
    return true;
  }

  if (c === 'yolo' || c === 'always-approve') {
    ctx.permissionMode = ctx.permissionMode === 'yolo' ? 'ask' : 'yolo';
    return true;
  }

  if (c === 'ask') {
    ctx.permissionMode = 'ask';
    return true;
  }

  if (c === 'accept-edits') {
    ctx.permissionMode = 'accept-edits';
    return true;
  }

  // /model  or  /model <id>  or  /m
  if (c === 'model' || c === 'models' || c === 'm') {
    if (!arg) {
      try {
        const models = await listModels(ctx.client);
        const options = models.slice(0, 40).map((m) => ({
          label: m.id,
          hint: m.owned_by || 'available',
          action: m.id,
        }));
        const picked = await pickOptions(ctx, {
          title: 'models',
          subtitle: `current  ${ctx.model}`,
          options,
          initialIndex: Math.max(0, options.findIndex((item) => item.action === ctx.model)),
          footer: '↑/↓ move  Enter select  Esc cancel',
          searchable: true,
        });
        if (picked) ctx.model = picked.action ?? picked;
      } catch (e) {
        notify(ctx, `Failed to list models: ${e.message}`, 'error');
      }
      return true;
    }
    ctx.model = arg;
    return true;
  }

  // /effort or /think adjusts model reasoning intensity.
  if (c === 'effort' || c === 'think') {
    if (!arg) {
      const levels = ['off', 'low', 'medium', 'high', 'xhigh'];
      const picked = await pickOptions(ctx, {
        title: 'Reasoning effort',
        subtitle: `current  ${ctx.effort}`,
        options: levels.map((level) => ({ label: level, action: level })),
        initialIndex: Math.max(0, levels.indexOf(ctx.effort)),
      });
      if (picked) ctx.effort = picked.action ?? picked;
      return true;
    }
    const v = arg.toLowerCase();
    const allowed = ['low', 'medium', 'high', 'xhigh', 'max', 'off', 'none'];
    if (!allowed.includes(v)) {
      notify(ctx, `Invalid effort: ${arg}. Use low, medium, high, xhigh, or off.`, 'error');
      return true;
    }
    ctx.effort = v === 'none' ? 'off' : v === 'max' ? 'xhigh' : v;
    return true;
  }

  if (c === 'thinking' || c === 'think-show' || c === 'show-thinking') {
    ctx.showThinking = !ctx.showThinking;
    notify(ctx, `Thinking display ${ctx.showThinking ? 'on' : 'off'}.`, 'success');
    return true;
  }

  if (c === 'logout') {
    logout();
    notify(ctx, 'Logged out.', 'warning');
    return 'exit';
  }

  if (c === 'home' || c === 'welcome') {
    notify(ctx, 'You are already in the coding workspace.');
    return true;
  }

  if (c === 'dashboard') {
    const origin = loadConfig().webOrigin || DEFAULT_WEB_ORIGIN;
    openBrowser(`${origin.replace(/\/$/, '')}/api/dashboard`);
    notify(ctx, 'Opened dashboard in your browser.', 'success');
    return true;
  }

  if (c === 'config') {
    const config = loadConfig();
    showInfo(ctx, 'Configuration', [
      ['model', config.model],
      ['permission', config.permissionMode],
      ['effort', config.reasoningEffort],
      ['thinking', config.showThinking ? 'visible' : 'hidden'],
      ['max turns', config.maxTurns],
      ['base URL', config.baseUrl],
    ]);
    return true;
  }

  notify(ctx, `Unknown command: /${cmd}. Try /help.`, 'warning');
  return true;
}

function printHelp() {
  console.log(`
  ${t.bold('commands')}  ${t.dim('workspace controls')}
  ${t.dim('─'.repeat(42))}
  /help                 this help
  /status               session + auth info
  /sessions             list and resume sessions
  /model [id]           list or switch model
  /effort [level]       reasoning: low|medium|high|xhigh|off
  /thinking             toggle reasoning display
  /details              toggle tool execution details
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

function showHelp(ctx) {
  const rows = [
    ['/help', 'show commands'],
    ['/status', 'session and runtime info'],
    ['/sessions', 'resume a saved session'],
    ['/model', 'search and switch model'],
    ['/effort', 'set reasoning intensity'],
    ['/thinking', 'toggle reasoning display'],
    ['/details', 'toggle tool details'],
    ['/ask', 'ask before writes'],
    ['/accept-edits', 'allow file edits'],
    ['/yolo', 'allow all tools'],
    ['/new', 'start a new session'],
    ['/dashboard', 'open web dashboard'],
    ['/exit', 'quit'],
  ];
  if (ctx.ui.showInfo) ctx.ui.showInfo('Commands', rows);
  else printHelp();
}

function showInfo(ctx, title, rows) {
  if (ctx.ui.showInfo) ctx.ui.showInfo(title, rows);
  else {
    console.log(`\n  ${t.bold(title)}`);
    for (const [key, value] of rows) console.log(`  ${t.dim(String(key).padEnd(12))} ${value}`);
    console.log('');
  }
}

function notify(ctx, message, tone = 'muted') {
  if (ctx.ui.addNotice) ctx.ui.addNotice(message, tone);
  else {
    const paint = tone === 'error' ? t.red : tone === 'warning' ? t.yellow : tone === 'success' ? t.green : t.dim;
    console.log(paint(`\n  ${message}\n`));
  }
}

async function pickOptions(ctx, options) {
  if (ctx.ui.pick) return ctx.ui.pick(options);
  return selectMenu(options);
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
  const state = { model, mode, effort, cwd, user, sessionId, print, showToolDetails: false };
  let assistantLineStart = true;
  let reasoningLineStart = true;
  let assistantCells = 0;
  let reasoningCells = 0;

  function writeStream(text, indent, paint) {
    const assistant = indent === '   ';
    let lineStart = assistant ? assistantLineStart : reasoningLineStart;
    let cells = assistant ? assistantCells : reasoningCells;
    const max = Math.max(8, termWidth() - indent.length - 1);
    let buffer = '';

    function flush() {
      if (!buffer) return;
      process.stdout.write(paint(buffer));
      buffer = '';
    }

    for (const char of String(text)) {
      if (char === '\r') continue;
      if (char === '\n') {
        flush();
        process.stdout.write('\n');
        lineStart = true;
        cells = 0;
        continue;
      }
      const charWidth = displayWidth(char);
      if (!lineStart && cells + charWidth > max) {
        flush();
        process.stdout.write('\n');
        lineStart = true;
        cells = 0;
      }
      if (lineStart) {
        process.stdout.write(indent);
        lineStart = false;
      }
      buffer += char;
      cells += charWidth;
    }
    flush();

    if (assistant) {
      assistantLineStart = lineStart;
      assistantCells = cells;
    } else {
      reasoningLineStart = lineStart;
      reasoningCells = cells;
    }
  }

  function statusLine() {
    return statusBar({
      model: state.model,
      mode: state.mode,
      effort: state.effort,
      cwd: state.cwd,
      user: state.user,
      session: state.sessionId,
    })
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
  }

  function mount(notice) {
    clearScreen();
    console.log('');
    console.log(statusLine());
    console.log(t.border(`  ${'─'.repeat(Math.max(12, Math.min(termWidth() - 4, 82)))}`));
    console.log(t.dim(`  ${icons.spark}  ready  ·  ${shortPath(state.cwd)}`));
    if (notice) console.log(t.accent(`  ${icons.check}  ${notice}`));
    console.log('');
    console.log(footerHints(['/model', '/effort', '/details']));
    console.log('');
  }

  function writeContext(notice) {
    console.log(`\n${statusLine()}`);
    if (notice) console.log(t.accent(`  ${icons.check}  ${notice}`));
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
        `  · ${state.model}  ·  ${usage.prompt_tokens || 0} in / ${usage.completion_tokens || 0} out`,
      ),
    );
  }

  function agentHooks() {
    return {
      onThinking(turn) {
        console.log(`\n${thinkingLine(turn)}`);
        reasoningLineStart = true;
        reasoningCells = 0;
      },
      onReasoningDelta(text) {
        writeStream(text, '    ', t.dim);
      },
      onDelta(text) {
        writeStream(text, '   ', t.agent);
      },
      onAssistantStart() {
        console.log(t.accent('\n  ✦'));
        assistantLineStart = true;
        assistantCells = 0;
      },
      onAssistantEnd() {
        process.stdout.write('\n');
      },
      onToolPending(name, detail) {
        void name;
        void detail;
      },
      onToolStart(name, detail) {
        if (state.showToolDetails) console.log(toolCard(name, detail, 'running', null, true));
      },
      onToolEnd(name, detail, status, result) {
        console.log(toolCard(name, detail, status, result, state.showToolDetails));
      },
      onTodo(todos) {
        const active = todos.filter((todo) => todo.status === 'in_progress').length;
        const done = todos.filter((todo) => todo.status === 'completed').length;
        console.log(t.dim(`  ☷ tasks  ${done}/${todos.length} complete${active ? `  ·  ${active} active` : ''}`));
      },
      onNotice(text, tone) {
        const paint = tone === 'warning' ? t.yellow : tone === 'error' ? t.red : t.dim;
        console.log(paint(`  ${text}`));
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
    setToolDetails(v) {
      state.showToolDetails = v;
    },
    mount,
    writeContext,
    writeUser,
    writePrompt,
    writeUsage,
    agentHooks,
  };
}

function formatSessionDate(value) {
  if (!value) return 'unknown time';
  return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
