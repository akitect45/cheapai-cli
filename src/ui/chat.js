import readline from 'node:readline/promises';
import path from 'node:path';
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
  statusBanner,
} from './draw.js';
import {
  createClient,
  fetchAccountUsage,
  listModels,
  modelInfo,
  persistModel,
  persistEffort,
} from '../llm/client.js';
import {
  loadConfig,
  loadScopedConfig,
  resolveModel,
  resolveBaseUrl,
  loadAuth,
  saveConfig,
} from '../config.js';
import { whoami, logout, openBrowser } from '../auth.js';
import { buildSystemPrompt } from '../prompts/system.js';
import {
  createSession,
  acquireSession,
  bindSessionLease,
  releaseSessionLease,
  transferSessionLease,
  loadSession,
  findLatestSession,
  forkSession,
  listSessions,
  deleteSession,
  saveSession,
} from '../agent/session.js';
import { createAgentRuntime } from '../agent/loop.js';
import { DEFAULT_WEB_ORIGIN } from '../config.js';
import { selectMenu } from './select.js';
import { createFullscreenChatUi } from './fullscreen.js';
import { compactSession } from '../agent/compact.js';
import { exportSession as writeSessionExport } from '../agent/export.js';
import { copyText } from './clipboard.js';
import { loadCustomAgents, loadCustomCommands, renderCustomCommand } from '../agent/commands.js';
import {
  accountUsageRows,
  contextUsageLabel,
  estimateMessagesTokens,
  formatTokens,
  formatWon,
  sessionUsageRows,
} from '../agent/usage.js';
import { redoTurn, undoTurn } from '../agent/history.js';
import { formatUpdateNotice, installLatestVersion } from '../update.js';
import { loadExtensions } from '../resources/extensions.js';

/**
 * Append-only interactive chat for a focused coding workspace.
 * Slash commands actually change runtime state.
 */
export async function startChatTui({
  prompt = '',
  opts = {},
  print = false,
  updateInfo = null,
} = {}) {
  const startupUpdate = updateInfo || opts.updateInfo || null;
  const updateInfoPromise = opts.updateInfoPromise || null;
  const requestedCwd = path.resolve(opts.cwd || process.cwd());
  const cfg = loadScopedConfig(requestedCwd);
  let session;
  let sessionLease = null;
  /** False until the first real chat turn (or an explicit resume) writes to disk. */
  let sessionPersisted = false;
  if (opts.resume) {
    session = loadSession(opts.resume);
    if (!session) throw new Error(`세션 없음: ${opts.resume}`);
  } else if (opts.continue) {
    session = findLatestSession(requestedCwd);
  }
  if (opts.fork && !session) {
    throw new Error('--fork requires --continue or --resume with an existing session.');
  }
  if (session && opts.fork) session = forkSession(session, { title: opts.title });
  if (session) {
    sessionLease = acquireSession(session.id);
    bindSessionLease(session, sessionLease);
    sessionPersisted = true;
  }
  try {
  const cwd = path.resolve(session?.cwd || requestedCwd);
  process.chdir(cwd);
  const customCommands = loadCustomCommands(cwd);
  const customAgents = loadCustomAgents(cwd);
  let extensionRuntime = { extensions: [], tools: [], commands: [], hooks: new Map() };

  let model = session?.model && !opts.model ? session.model : resolveModel(opts.model, cfg);
  let agentName = opts.agent || session?.agent || 'build';
  let reasoningEffort = opts.effort || cfg.reasoningEffort || 'off';
  let permissionMode = opts.yolo
    ? 'yolo'
    : opts.permissionMode || cfg.permissionMode || 'ask';
  // 0 = unlimited tool loops; use nullish coalescing so 0 is not treated as missing.
  let maxTurns = opts.maxTurns ?? cfg.maxTurns ?? 0;
  if (!Number.isFinite(Number(maxTurns)) || Number(maxTurns) < 0) maxTurns = 0;
  else maxTurns = Math.floor(Number(maxTurns));
  let showThinking = cfg.showThinking !== false;
  let showBalance = cfg.showBalance === true;
  let showToolDetails = false;
  let goalMode = !!session?.goalMode;
  let contextWindow = Number(session?.contextWindow) || null;
  let accountUsage = null;
  const autoCompact = opts.autoCompact ?? cfg.autoCompact !== false;
  const compactThreshold = Math.min(0.95, Math.max(0.5, Number(cfg.compactThreshold) || 0.8));
  const me = whoami();
  let activeController = null;
  let activeRuntime = null;

  let { client, baseURL, apiKey } = createClient({ model });

  function agentInstructions() {
    return customAgents.find((agent) => agent.name === agentName)?.instructions || '';
  }

  function persistSession() {
    if (!session || !sessionPersisted) return;
    saveSession(session);
  }

  if (!session) {
    // In-memory draft only — nothing is written until the first chat turn.
    session = createSession({
      cwd,
      model,
      systemPrompt: buildSystemPrompt({ cwd, model, goalMode, agentInstructions: agentInstructions() }),
    });
    session.goalMode = goalMode;
    session.agent = agentName;
    if (opts.title) session.title = String(opts.title).trim().slice(0, 80);
    sessionPersisted = false;
  } else {
    session.cwd = cwd;
    session.model = model;
    session.goalMode = goalMode;
    session.agent = agentName;
    if (opts.title) session.title = String(opts.title).trim().slice(0, 80);
    if (session.messages?.[0]?.role === 'system') {
      session.messages[0].content = buildSystemPrompt({ cwd, model, goalMode, agentInstructions: agentInstructions() });
    }
    persistSession();
  }

  extensionRuntime = await loadExtensions({
    cwd,
    session,
    approvedPaths: Array.isArray(cfg.approvedExtensions) ? cfg.approvedExtensions : [],
  });
  customCommands.push(...extensionRuntime.commands.filter((command) => command?.name && command?.template));

  const fullscreen = !print && input.isTTY && output.isTTY;
  const ui = fullscreen ? createFullscreenChatUi({
    model,
    mode: permissionMode,
    effort: reasoningEffort,
    cwd,
    user: me.username,
    sessionId: sessionPersisted ? session.id : '',
    sessionTitle: session.title,
    showThinking,
    goalMode,
    sessionUsage: sessionPersisted ? session.usage : {},
    contextWindow: sessionPersisted ? contextWindow : null,
    contextTokens: sessionPersisted ? session.lastContextTokens : null,
    accountUsage,
    showBalance,
    commands: customCommands,
    agent: agentName,
    messages: sessionPersisted ? session.messages : [],
  }) : createChatUi({
    model,
    mode: permissionMode,
    effort: reasoningEffort,
    goalMode,
    cwd,
    user: me.username,
    sessionId: sessionPersisted ? session.id : '',
    print,
  });
  ui.setAbortHandler?.(() => activeController?.abort());
  ui.setBusySubmitHandler?.(({ text, mode }) => {
    if (!activeRuntime?.active) return false;
    if (mode === 'promote') {
      const promoted = activeRuntime.promoteFollowUpsToSteering();
      const extra = String(text || '').trim();
      if (extra) activeRuntime.enqueueSteering(extra);
      if (!promoted && !extra) return false;
      const snap = activeRuntime.queueSnapshot();
      ui.setPendingQueue?.(snap.followUps);
      return true;
    }
    const value = String(text || '').trim();
    if (!value) return false;
    if (!activeRuntime.enqueueFollowUp(value)) return false;
    // Show in the transcript immediately so the user sees what will run next.
    if (!print) ui.writeUser?.(value);
    const snap = activeRuntime.queueSnapshot();
    ui.setPendingQueue?.(snap.followUps);
    return true;
  });

  /** Materialize a draft session on disk the first time the user chats. */
  function ensureSessionPersisted() {
    if (!session || sessionPersisted) return;
    sessionLease = acquireSession(session.id);
    bindSessionLease(session, sessionLease);
    saveSession(session);
    sessionPersisted = true;
    ui.sessionId = session.id;
    ui.sessionTitle = session.title || '';
  }

  function refreshClient() {
    ({ client, baseURL, apiKey } = createClient({ model }));
  }

  async function refreshModelInfo() {
    try {
      const info = await modelInfo(client, model);
      const nextWindow = Number(info?.context_window || info?.contextWindow || 0);
      if (nextWindow > 0) {
        contextWindow = nextWindow;
        session.contextWindow = nextWindow;
        persistSession();
        ui.setContextWindow?.(contextWindow);
      }
    } catch {
      // Context metadata is optional; usage and chat remain available without it.
    }
    return contextWindow;
  }

  async function refreshAccountUsage({ show = false } = {}) {
    try {
      accountUsage = await fetchAccountUsage({ baseURL, apiKey });
      ui.setAccountUsage?.(accountUsage);
      if (show) showInfo(uiContext(), 'Account usage', accountUsageRows(accountUsage));
      return accountUsage;
    } catch (error) {
      if (show) notify(uiContext(), `Usage unavailable: ${error.message}`, 'error');
      return null;
    }
  }

  async function compactCurrent({ silent = false } = {}) {
    if (print) return { compacted: false, reason: 'Compaction is unavailable in print mode.' };
    if (!sessionPersisted) return { compacted: false, reason: 'Nothing to compact yet.' };
    ui.setBusy?.(true);
    showCompactBanner('compacting now...', 'warning');
    try {
      const result = await compactSession({ client, model, session });
      if (result.compacted) {
        ui.resetSession?.(session.id, session.title || '', '', session.messages);
        ui.setSessionUsage?.(session.usage, contextWindow, session.lastContextTokens);
        showCompactBanner('compacted', 'success');
        if (!silent) {
          ui.addNotice?.(
            `${formatTokens(result.beforeTokens)} → ${formatTokens(result.afterTokens)} tokens`,
            'success',
          );
        }
      } else {
        showCompactBanner('compact skipped', 'muted');
        if (!silent) ui.addNotice?.(result.reason || 'Nothing to compact.', 'muted');
      }
      return result;
    } catch (error) {
      showCompactBanner('compaction failed', 'error');
      if (!silent) ui.addNotice?.(`Compaction failed: ${error.message}`, 'error');
      return { compacted: false, reason: error.message, error };
    } finally {
      ui.setBusy?.(false);
    }
  }

  function showCompactBanner(label, tone = 'muted') {
    if (ui.addBanner) {
      ui.addBanner(label, tone);
      return;
    }
    const paint = tone === 'error' ? t.red : tone === 'warning' ? t.yellow : tone === 'success' ? t.green : t.dim;
    console.log(`\n${statusBanner(label, termWidth() - 2, paint)}\n`);
  }

  async function maybeAutoCompact(text) {
    if (!autoCompact || !contextWindow || print) return;
    const localEstimate = estimateMessagesTokens([
      ...(session.messages || []),
      { role: 'user', content: text },
    ]);
    const recentEstimate = Number(session.lastContextTokens || 0)
      + estimateMessagesTokens([{ role: 'user', content: text }]);
    const estimate = Math.max(localEstimate, recentEstimate);
    if (estimate < contextWindow * compactThreshold) return;
    ui.writeContext(`context near limit  ${formatTokens(estimate)} / ${formatTokens(contextWindow)}`);
    await compactCurrent({ silent: true });
  }

  function uiContext() {
    return {
      ui,
      session,
      get model() { return model; },
      get effort() { return reasoningEffort; },
      get showThinking() { return showThinking; },
      get goalMode() { return goalMode; },
      get permissionMode() { return permissionMode; },
      get autoCompact() { return autoCompact; },
      cwd,
    };
  }

  const runOnce = async (text) => {
    ensureSessionPersisted();
    await maybeAutoCompact(text);
    if (!print) ui.writeUser(text);
    activeController = new AbortController();
    const runtime = createAgentRuntime({
      client,
      model,
      session,
      permissionMode,
      maxTurns,
      temperature: cfg.temperature ?? 0.2,
      reasoningEffort: reasoningEffort === 'off' ? null : reasoningEffort,
      showThinking,
      goalMode,
      print,
      signal: activeController.signal,
      alwaysApprove: permissionMode === 'yolo',
      onPermissionModeChange: (mode) => {
        permissionMode = mode;
        ui.mode = mode;
        ui.writeContext('all tools allowed until exit');
      },
      requestPermission: ui.requestPermission || null,
      ui: print ? null : ui.agentHooks(),
      customTools: extensionRuntime.tools,
      eventHooks: extensionRuntime.hooks,
      streamIdleTimeoutMs: Number(cfg.streamIdleTimeoutMs) > 0 ? Number(cfg.streamIdleTimeoutMs) : undefined,
      pathMode: permissionMode === 'yolo' ? 'unrestricted' : cfg.pathMode || 'workspace',
      extraRoots: Array.isArray(cfg.extraRoots) ? cfg.extraRoots : [],
    });
    activeRuntime = runtime;
    try {
      const result = await runtime.run(text);
      if (!print && result.usage) {
        ui.writeUsage(result.usage, session.usage, contextWindow, session.lastContextTokens);
      }
      if (!print && showBalance) void refreshAccountUsage();
      if (!print) ui.sessionTitle = session.title;
      return result;
    } finally {
      activeRuntime = null;
      activeController = null;
      ui.setPendingQueue?.([]);
      ui.setBusy?.(false);
    }
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
      void refreshModelInfo();
      if (showBalance) void refreshAccountUsage();
      if (prompt) {
        try {
          await runOnce(prompt);
        } catch (error) {
          ui.addNotice(error.message || String(error), 'error');
          ui.setBusy(false);
        }
      }
      showStartupUpdate(ui, startupUpdate, updateInfoPromise);
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
          if (error?.name === 'AbortError' || /aborted|abort/i.test(error?.message || '')) {
            ui.resetSession?.(session.id, session.title || '', '', session.messages);
            ui.setSessionUsage?.(session.usage, contextWindow, session.lastContextTokens);
            ui.addNotice('Generation stopped.', 'warning');
          } else {
            ui.addNotice(error.message || String(error), 'error');
          }
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
  void refreshModelInfo();
  if (showBalance) void refreshAccountUsage();

  if (prompt) {
    await runOnce(prompt);
  }
  showStartupUpdate(ui, startupUpdate, updateInfoPromise);

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
    function activateSession(next, notice) {
      const nextLease = next.id === session.id ? sessionLease : acquireSession(next.id);
      const previousSession = session;
      if (next !== previousSession) {
        if (next.id === previousSession.id) transferSessionLease(previousSession, next);
        else bindSessionLease(next, nextLease);
      }
      session = next;
      sessionLease = nextLease;
      sessionPersisted = true;
      if (previousSession !== next && previousSession.id !== next.id) releaseSessionLease(previousSession);
      model = next.model || model;
      agentName = next.agent || 'build';
      goalMode = !!next.goalMode;
      contextWindow = Number(next.contextWindow) || null;
      if (next.messages?.[0]?.role === 'system') {
        next.messages[0].content = buildSystemPrompt({ cwd, model, goalMode, agentInstructions: agentInstructions() });
      }
      ui.model = model;
      ui.setAgent?.(agentName);
      ui.setGoalMode?.(goalMode);
      ui.sessionId = next.id;
      ui.sessionTitle = next.title || '';
      refreshClient();
      if (ui.resetSession) ui.resetSession(next.id, next.title || '', notice, next.messages);
      else ui.mount(notice);
      ui.setSessionUsage?.(next.usage, contextWindow, next.lastContextTokens);
      ui.setContextWindow?.(contextWindow);
      void refreshModelInfo();
    }

    function refreshSessionView(notice) {
      if (ui.resetSession) ui.resetSession(session.id, session.title || '', notice, session.messages);
      else ui.writeContext(notice);
      ui.setSessionUsage?.(session.usage, contextWindow, session.lastContextTokens);
      ui.sessionTitle = session.title || '';
    }

    return {
      ui,
      get session() {
        return session;
      },
      get sessionSaved() {
        return sessionPersisted;
      },
      get model() {
        return model;
      },
      set model(value) {
        model = value;
        session.model = value;
        session.contextWindow = null;
        session.lastContextTokens = estimateMessagesTokens(session.messages || []);
        contextWindow = null;
        ui.model = value;
        ui.setContextWindow?.(null);
        persistModel(value);
        if (session.messages?.[0]?.role === 'system') {
          session.messages[0].content = buildSystemPrompt({ cwd, model, goalMode, agentInstructions: agentInstructions() });
        }
        persistSession();
        refreshClient();
        void refreshModelInfo();
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
      get maxTurns() {
        return maxTurns;
      },
      set maxTurns(value) {
        const next = Math.floor(Number(value));
        if (!Number.isFinite(next) || next < 0) return;
        maxTurns = next;
        const config = loadConfig();
        config.maxTurns = next;
        saveConfig(config);
        ui.writeContext(next === 0 ? 'max turns unlimited' : `max turns ${next}`);
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
      get goalMode() {
        return goalMode;
      },
      get agent() {
        return agentName;
      },
      set agent(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (!['build', ...customAgents.map((agent) => agent.name)].includes(normalized)) return;
        agentName = normalized;
        session.agent = agentName;
        if (session.messages?.[0]?.role === 'system') {
          session.messages[0].content = buildSystemPrompt({ cwd, model, goalMode, agentInstructions: agentInstructions() });
        }
        persistSession();
        ui.setAgent?.(agentName);
        ui.writeContext(`agent ${agentName}`);
      },
      get showBalance() {
        return showBalance;
      },
      set showBalance(value) {
        showBalance = !!value;
        ui.setShowBalance?.(showBalance);
        const config = loadConfig();
        config.showBalance = showBalance;
        saveConfig(config);
      },
      set goalMode(value) {
        goalMode = !!value;
        session.goalMode = goalMode;
        if (session.messages?.[0]?.role === 'system') {
          session.messages[0].content = buildSystemPrompt({ cwd, model, goalMode, agentInstructions: agentInstructions() });
        }
        persistSession();
        ui.setGoalMode?.(goalMode);
        ui.writeContext(`goal mode ${goalMode ? 'on · plan only' : 'off'}`);
      },
      cwd,
      get client() {
        return client;
      },
      recreateSession() {
        goalMode = false;
        const previousSession = session;
        const previousPersisted = sessionPersisted;
        const next = createSession({
          cwd,
          model,
          systemPrompt: buildSystemPrompt({ cwd, model, goalMode, agentInstructions: agentInstructions() }),
        });
        session = next;
        session.goalMode = false;
        session.agent = agentName;
        contextWindow = null;
        sessionPersisted = false;
        sessionLease = null;
        if (previousPersisted) releaseSessionLease(previousSession);
        ui.sessionId = '';
        ui.sessionTitle = '';
        ui.setGoalMode?.(false);
        if (ui.resetSession) ui.resetSession('', '', 'new chat · session starts on first message', []);
        else ui.mount('new chat · session starts on first message');
        ui.setSessionUsage?.({}, null, null);
        ui.setContextWindow?.(null);
        void refreshModelInfo();
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
        activateSession(next, `resumed ${next.title || next.id.slice(0, 8)}`);
      },
      removeSession(id) {
        const targetId = String(id || '');
        if (!targetId) return false;
        const wasCurrent = sessionPersisted && session.id === targetId;
        // Active session holds the lease — release first so delete can lock and remove files.
        if (wasCurrent) {
          releaseSessionLease(session);
          sessionLease = null;
          sessionPersisted = false;
        }
        let deleted = false;
        try {
          deleted = deleteSession(targetId);
        } catch (error) {
          if (wasCurrent) {
            try {
              sessionLease = acquireSession(session.id);
              bindSessionLease(session, sessionLease);
              sessionPersisted = true;
            } catch {
              this.recreateSession();
            }
          }
          throw error;
        }
        if (!deleted) {
          if (wasCurrent && !sessionLease) {
            try {
              sessionLease = acquireSession(session.id);
              bindSessionLease(session, sessionLease);
              sessionPersisted = true;
            } catch {
              this.recreateSession();
            }
          }
          return false;
        }
        if (wasCurrent) this.recreateSession();
        return true;
      },
      get accountUsage() {
        return accountUsage;
      },
      get contextWindow() {
        return contextWindow;
      },
      get autoCompact() {
        return autoCompact;
      },
      customCommands,
      customAgents,
      async refreshUsage(show = false) {
        return refreshAccountUsage({ show });
      },
      async compact() {
        return compactCurrent();
      },
      rename(title) {
        const value = String(title || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        if (!value) return false;
        session.title = value;
        if (!sessionPersisted) {
          // Renaming is a real session action — create the file so /sessions can find it.
          ensureSessionPersisted();
        } else {
          persistSession();
        }
        ui.sessionTitle = value;
        ui.writeContext('session renamed');
        return true;
      },
      exportSession(targetPath) {
        ensureSessionPersisted();
        return writeSessionExport(session, targetPath);
      },
      fork(title) {
        ensureSessionPersisted();
        const next = forkSession(session, { title });
        activateSession(next, `forked from ${session.id.slice(0, 8)}`);
        return next;
      },
      undo() {
        if (!sessionPersisted) return { ok: false, reason: 'Nothing to undo yet.' };
        const result = undoTurn(session);
        if (result.ok) refreshSessionView('last turn undone');
        return result;
      },
      redo() {
        if (!sessionPersisted) return { ok: false, reason: 'Nothing to redo yet.' };
        const result = redoTurn(session);
        if (result.ok) refreshSessionView('last turn restored');
        return result;
      },
      async retry() {
        if (!sessionPersisted) return { ok: false, reason: 'Nothing to retry yet.' };
        const result = undoTurn(session);
        if (!result.ok) return result;
        refreshSessionView('retrying last turn');
        if (!result.prompt) return { ok: false, reason: 'Last turn has no user prompt.' };
        await runOnce(result.prompt);
        return { ok: true };
      },
      async copyLastAssistant() {
        const message = [...(session.messages || [])].reverse().find((item) => item.role === 'assistant' && item.content);
        if (!message) return false;
        return copyText(message.content);
      },
      async runUpdate() {
        ui.addNotice('Updating...', 'warning');
        ui.setBusy(true);
        ui.destroy();
        let result;
        let failure = null;
        try {
          result = await installLatestVersion();
          process.stdout.write(`\n${result.message}\n\n`);
        } catch (error) {
          failure = error;
          process.stdout.write(`\nUpdate failed: ${error.message || error}\n\n`);
        } finally {
          ui.mount();
          ui.setBusy(false);
        }
        if (failure) {
          ui.addNotice(`Update failed: ${failure.message || failure}`, "error");
          throw failure;
        }
        ui.addNotice(result.message, result.updated ? 'success' : 'muted');
        return result;
      },
      async runPrompt(text) {
        return runOnce(text);
      },
    };
  }
  } finally {
    if (sessionPersisted && session) releaseSessionLease(session);
    else sessionLease?.release();
  }
}

function showStartupUpdate(ui, startupUpdate, updateInfoPromise) {
  const show = (info) => {
    if (!info) return;
    const text = formatUpdateNotice(info);
    if (typeof ui.addBanner === 'function') ui.addBanner(text, 'warning');
    else ui.addNotice?.(text, 'warning');
  };
  if (startupUpdate) {
    show(startupUpdate);
    return;
  }
  if (!updateInfoPromise) return;
  void Promise.resolve(updateInfoPromise).then(show).catch(() => {});
}

export async function handleSlash(line, ctx) {
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

  if (c === 'goal') {
    const value = arg.toLowerCase();
    if (value && !['on', 'off'].includes(value)) {
      notify(ctx, 'Use /goal, /goal on, or /goal off.', 'error');
      return true;
    }
    ctx.goalMode = value ? value === 'on' : !ctx.goalMode;
    return true;
  }

  if (c === 'compact' || c === 'compact-context') {
    await ctx.compact();
    return true;
  }

  if (c === 'undo' || c === 'revert') {
    const result = ctx.undo();
    if (!result.ok) notify(ctx, result.reason, 'warning');
    else if (result.shellChanges || result.filesSkipped) notify(ctx, `Undid the conversation · ${result.filesRestored} file(s) restored · ${result.filesSkipped} conflict(s) skipped · ${result.shellChanges} shell operation(s) not reverted.`, 'warning');
    else notify(ctx, `Undid last turn · ${result.filesRestored} file(s) restored.`, 'success');
    return true;
  }

  if (c === 'redo' || c === 'unrevert') {
    const result = ctx.redo();
    if (!result.ok) notify(ctx, result.reason, 'warning');
    else if (result.shellChanges || result.filesSkipped) notify(ctx, `Restored the conversation · ${result.filesRestored} file(s) restored · ${result.filesSkipped} conflict(s) skipped · ${result.shellChanges} shell operation(s) not replayed.`, 'warning');
    else notify(ctx, `Restored last turn · ${result.filesRestored} file(s) restored.`, 'success');
    return true;
  }

  if (c === 'fork') {
    const next = ctx.fork(arg || undefined);
    notify(ctx, `Forked session ${next.id.slice(0, 8)}.`, 'success');
    return true;
  }

  if (c === 'retry') {
    const result = await ctx.retry();
    if (!result.ok) notify(ctx, result.reason || 'Nothing to retry.', 'warning');
    return true;
  }

  if (c === 'copy') {
    const copied = await ctx.copyLastAssistant();
    notify(ctx, copied ? 'Copied the last answer.' : 'No assistant answer to copy.', copied ? 'success' : 'warning');
    return true;
  }

  if (c === 'search') {
    if (!arg) {
      notify(ctx, 'Usage: /search <text>', 'warning');
      return true;
    }
    const query = arg.toLowerCase();
    const rows = [];
    for (const message of ctx.session.messages || []) {
      if (!['user', 'assistant', 'tool'].includes(message.role)) continue;
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '');
      const index = text.toLowerCase().indexOf(query);
      if (index < 0) continue;
      const start = Math.max(0, index - 36);
      rows.push([message.role, text.slice(start, start + 120).replace(/\s+/g, ' ')]);
    }
    showInfo(ctx, `Search · ${arg}`, rows.length ? rows : [['result', 'No matches']]);
    return true;
  }

  if (c === 'agent') {
    const options = [
      { label: 'build', hint: 'default coding agent', action: 'build' },
      ...((ctx.customAgents || []).map((agent) => ({ label: agent.name, hint: agent.description, action: agent.name }))),
    ];
    if (!arg) {
      const picked = await pickOptions(ctx, {
        title: 'Agents',
        subtitle: `current  ${ctx.agent}`,
        options,
        initialIndex: Math.max(0, options.findIndex((item) => item.action === ctx.agent)),
        searchable: true,
      });
      if (picked) ctx.agent = picked.action ?? picked;
    } else {
      const available = options.map((item) => item.action);
      if (!available.includes(arg.toLowerCase())) notify(ctx, `Unknown agent: ${arg}`, 'warning');
      else ctx.agent = arg;
    }
    return true;
  }

  const custom = (ctx.customCommands || []).find((command) => command.name === c);
  if (custom) {
    const prompt = renderCustomCommand(custom, arg);
    if (!prompt) notify(ctx, `Custom command /${c} is empty.`, 'warning');
    else await ctx.runPrompt(prompt);
    return true;
  }

  if (c === 'usage' || c === 'stats') {
    const account = await ctx.refreshUsage(false);
    const contextTokens = currentContextTokens(ctx.session);
    const rows = [
      ...sessionUsageRows(ctx.session.usage, contextTokens, ctx.contextWindow),
      ['account balance', account ? formatWon(account.balance ?? account.credits) : 'unavailable'],
      ['today', account ? formatWon(account.spentToday ?? account.spent) : 'unavailable'],
      ['this month', account ? formatWon(account.spentMonth) : 'unavailable'],
    ];
    showInfo(ctx, 'Usage', rows);
    return true;
  }

  if (c === 'credits') {
    const value = arg.toLowerCase();
    if (value && !['on', 'off'].includes(value)) {
      notify(ctx, 'Use /credits, /credits on, or /credits off.', 'warning');
      return true;
    }
    if (value) {
      ctx.showBalance = value === 'on';
      if (ctx.showBalance) await ctx.refreshUsage(false);
      notify(ctx, `Header credit ${ctx.showBalance ? 'shown' : 'hidden'}.`, 'success');
      return true;
    }
    const account = await ctx.refreshUsage(false);
    if (account) showInfo(ctx, 'Credits', accountUsageRows(account));
    else notify(ctx, 'Unable to load account credits.', 'error');
    return true;
  }

  if (c === 'context') {
    showInfo(ctx, 'Context', [
      ['estimate', contextUsageLabel(currentContextTokens(ctx.session), ctx.contextWindow)],
      ['compactions', ctx.session.compactions?.length || 0],
      ['auto compact', ctx.autoCompact ? 'on' : 'off'],
    ]);
    return true;
  }

  if (c === 'rename' || c === 'title') {
    if (!arg) notify(ctx, 'Usage: /rename <session title>', 'warning');
    else ctx.rename(arg);
    return true;
  }

  if (c === 'export') {
    try {
      const destination = ctx.exportSession(arg);
      notify(ctx, `Exported session to ${destination}`, 'success');
    } catch (error) {
      notify(ctx, `Export failed: ${error.message}`, 'error');
    }
    return true;
  }

  if (c === 'sessions' || c === 'resume') {
    while (true) {
      const sessions = listSessions(ctx.cwd);
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
        footer: '↑/↓ move  ·  Enter resume  ·  k delete  ·  Esc cancel',
        searchable: true,
        hotkeys: { k: 'delete' },
      });
      if (!picked) return true;

      if (picked.hotkey === 'delete') {
        const id = String(picked.action || picked.option?.action || '');
        const target = sessions.find((item) => item.id === id);
        if (!id || !target) {
          notify(ctx, 'Session not found.', 'error');
          continue;
        }
        const label = target.title || id.slice(0, 8);
        const confirm = await pickOptions(ctx, {
          title: 'Delete this session?',
          subtitle: `${label}  ·  ${id.slice(0, 8)}`,
          options: [
            { label: 'Delete', hint: 'Remove permanently', action: true },
            { label: 'Cancel', hint: 'Keep this session', action: false },
          ],
          initialIndex: 1,
          searchable: false,
          footer: '↑/↓ move  ·  Enter confirm  ·  Esc cancel',
        });
        if (confirm !== true) continue;

        try {
          if (!ctx.removeSession(id)) {
            notify(ctx, `Could not delete ${id.slice(0, 8)}.`, 'error');
            continue;
          }
        } catch (error) {
          notify(ctx, `Delete failed: ${error.message}`, 'error');
          continue;
        }
        notify(ctx, `Deleted session ${label}`, 'success');
        continue;
      }

      ctx.resumeSession(picked.action ?? picked);
      return true;
    }
  }

  if (c === 'status' || c === 'session' || c === 'info' || c === 'session-info') {
    const me = whoami();
    showInfo(ctx, 'Session', [
      ['version', VERSION],
      ['user', me.username || '—'],
      ['model', ctx.model],
      ['agent', ctx.agent || 'build'],
      ['effort', ctx.effort],
      ['thinking', ctx.showThinking ? 'visible' : 'hidden'],
      ['goal mode', ctx.goalMode ? 'on · plan only' : 'off'],
      ['permission', ctx.permissionMode],
      ['max turns', ctx.maxTurns === 0 ? 'unlimited' : ctx.maxTurns],
      ['session', ctx.sessionSaved ? ctx.session.id : 'not started'],
      ['workspace', ctx.cwd],
      ['base URL', resolveBaseUrl(loadConfig(), loadAuth())],
      ['messages', ctx.session.messages?.length || 0],
      ['context', contextUsageLabel(currentContextTokens(ctx.session), ctx.contextWindow)],
      ['compactions', ctx.session.compactions?.length || 0],
      ['session billed', formatWon(ctx.session.usage?.credits)],
      ['account balance', ctx.accountUsage ? formatWon(ctx.accountUsage.balance ?? ctx.accountUsage.credits) : 'not loaded'],
      ['auto compact', ctx.autoCompact ? 'on' : 'off'],
    ]);
    return true;
  }

  if (c === 'update') {
    if (typeof ctx.runUpdate !== 'function') {
      ctx.notify('This environment does not support /update. Run `cheapai --update`.', 'error');
      return true;
    }
    try {
      await ctx.runUpdate();
    } catch {
      // runUpdate has already restored the UI and presented the error.
    }
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

  // /model  or  /model <id>  or  /m  → then effort picker
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
        if (!picked) return true;
        ctx.model = picked.action ?? picked;
      } catch (e) {
        notify(ctx, `Failed to list models: ${e.message}`, 'error');
        return true;
      }
    } else {
      ctx.model = arg;
    }
    // After a model is chosen, always offer effort next.
    await pickEffort(ctx);
    return true;
  }

  // /effort or /think adjusts model reasoning intensity.
  if (c === 'effort' || c === 'think') {
    if (!arg) {
      await pickEffort(ctx);
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

  // /turn 60  ·  /turns 0 (0 = unlimited)
  if (c === 'turn' || c === 'turns' || c === 'max-turns' || c === 'maxturns') {
    if (!arg) {
      const label = ctx.maxTurns === 0 ? 'unlimited (0)' : String(ctx.maxTurns);
      notify(ctx, `Max turns: ${label}. Use /turn <n> (0 = unlimited).`);
      return true;
    }
    const token = arg.trim().toLowerCase();
    const unlimited = ['0', 'inf', 'infinite', 'unlimited', 'none'].includes(token);
    const value = unlimited ? 0 : Number(token);
    if (!unlimited && (!Number.isFinite(value) || !Number.isInteger(value) || value < 0)) {
      notify(ctx, 'Usage: /turn <n>  (positive integer, or 0 for unlimited)', 'warning');
      return true;
    }
    if (!unlimited && value > 10_000) {
      notify(ctx, 'Max turns must be between 0 and 10000 (0 = unlimited).', 'warning');
      return true;
    }
    ctx.maxTurns = unlimited ? 0 : value;
    notify(
      ctx,
      ctx.maxTurns === 0 ? 'Max turns set to unlimited.' : `Max turns set to ${ctx.maxTurns}.`,
      'success',
    );
    return true;
  }

  if (c === 'thinking' || c === 'think-show' || c === 'show-thinking') {
    ctx.showThinking = !ctx.showThinking;
    notify(ctx, `Thinking display ${ctx.showThinking ? 'on' : 'off'}.`, 'success');
    return true;
  }

  if (c === 'logout') {
    const result = logout();
    notify(
      ctx,
      result.loggedOut ? 'Logged out.' : `auth.json cleared; ${result.source} is still active.`,
      'warning',
    );
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
      ['header credit', config.showBalance ? 'visible' : 'hidden'],
      ['auto compact', config.autoCompact === false ? 'off' : 'on'],
      ['compact threshold', config.compactThreshold],
      ['max turns', config.maxTurns === 0 ? 'unlimited (0)' : config.maxTurns],
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
  /usage                session tokens + account spend
  /credits [on|off]     show account credits or toggle header
  /compact              summarize old context and continue
  /undo                 undo last turn and tracked file edits
  /redo                 restore last undone turn
  /fork [title]         branch from the current session
  /retry                undo and rerun the last prompt
  /copy                 copy the last assistant answer
  /search <text>        search the current transcript
  /context              context estimate and compaction info
  /sessions             list, resume, or delete sessions
  /model [id]           pick model, then effort
  /agent [name]         list or switch agent profile
  /effort [level]       reasoning: low|medium|high|xhigh|off
  /turn [n]             max tool loops (0 = unlimited)
  /thinking             toggle reasoning display
  /details              toggle tool execution details
  /goal [on|off]        plan goals without writes or shell
  /rename <title>       rename the current session
  /export [path]        export the transcript as Markdown
  /yolo                 toggle auto-approve tools
  /ask                  require tool approval
  /accept-edits         auto file edits
  /new  /clear          new session
  /dashboard            open cheapai.im dashboard
  /config               show local config
  /update               install latest published version
  /logout               clear credentials & exit
  /exit                 quit
`);
}

function showHelp(ctx) {
  const rows = [
    ['/help', 'show commands'],
    ['/status', 'session and runtime info'],
    ['/usage', 'session tokens and account spend'],
    ['/credits', 'show account credits or toggle header'],
    ['/compact', 'summarize old context and continue'],
    ['/undo', 'undo last turn and tracked edits'],
    ['/redo', 'restore last undone turn'],
    ['/fork', 'branch from the current session'],
    ['/retry', 'undo and rerun the last prompt'],
    ['/copy', 'copy the last assistant answer'],
    ['/search', 'search the current transcript'],
    ['/context', 'show context estimate and compactions'],
    ['/sessions', 'resume or delete a saved session'],
    ['/model', 'pick model, then effort'],
    ['/agent', 'list or switch agent profile'],
    ['/effort', 'set reasoning intensity'],
    ['/turn', 'max tool loops (0 = unlimited)'],
    ['/thinking', 'toggle reasoning display'],
    ['/details', 'toggle tool details'],
    ['/goal', 'plan goals without writes'],
    ['/rename', 'rename the current session'],
    ['/export', 'write a Markdown transcript'],
    ['/ask', 'ask before writes'],
    ['/accept-edits', 'allow file edits'],
    ['/yolo', 'allow all tools'],
    ['/new /clear', 'start a new session'],
    ['/dashboard', 'open web dashboard'],
    ['/config', 'show local configuration'],
    ['/update', 'install the latest published version'],
    ['/logout', 'clear credentials and quit'],
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

const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh'];

/** Interactive effort picker (also chained after /model). */
async function pickEffort(ctx) {
  const picked = await pickOptions(ctx, {
    title: 'Reasoning effort',
    subtitle: `model  ${ctx.model}  ·  current  ${ctx.effort}`,
    options: EFFORT_LEVELS.map((level) => ({
      label: level,
      hint: level === 'off' ? 'no extended thinking' : `${level} reasoning`,
      action: level,
    })),
    initialIndex: Math.max(0, EFFORT_LEVELS.indexOf(ctx.effort)),
    footer: '↑/↓ move  ·  Enter select  ·  Esc keep current',
  });
  if (picked == null) return false;
  ctx.effort = picked.action ?? picked;
  return true;
}

function restoreCookedTty() {
  try {
    if (input.isTTY && input.setRawMode) input.setRawMode(false);
    process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?1002l\x1b[?25h');
  } catch {
    /* ignore */
  }
}

function createChatUi({ model, mode, effort, goalMode, cwd, user, sessionId, print }) {
  const state = {
    model,
    mode,
    effort,
    goalMode,
    cwd,
    user,
    sessionId,
    print,
    showToolDetails: false,
    sessionUsage: {},
    contextWindow: null,
    accountUsage: null,
    busy: false,
  };
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
    console.log(t.border(`  ${'─'.repeat(Math.max(12, termWidth() - 4))}`));
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

  function writeUsage(usage, sessionUsage, contextWindow, contextTokens) {
    if (!usage) return;
    if (sessionUsage) state.sessionUsage = sessionUsage;
    if (contextWindow != null) state.contextWindow = Number(contextWindow) || null;
    if (contextTokens != null) state.contextTokens = Number(contextTokens) || 0;
    const costValue = usage.cost_credits ?? usage.cost_krw;
    const cost = Number(costValue) > 0 ? `  · ${formatWon(costValue)}` : '';
    console.log(
      t.dim(
        `  · ${state.model}  ·  ${formatTokens(usage.prompt_tokens || 0)} in / ${formatTokens(usage.completion_tokens || 0)} out${cost}`,
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
    setGoalMode(v) {
      state.goalMode = !!v;
    },
    set sessionId(v) {
      state.sessionId = v;
    },
    set sessionTitle(v) {
      state.sessionTitle = v || '';
    },
    setToolDetails(v) {
      state.showToolDetails = v;
    },
    setBusy(v) {
      state.busy = !!v;
    },
    setSessionUsage(v, contextWindow, contextTokens) {
      state.sessionUsage = v || {};
      if (contextWindow != null) state.contextWindow = Number(contextWindow) || null;
      if (contextTokens != null) state.contextTokens = Number(contextTokens) || 0;
    },
    setContextWindow(v) {
      state.contextWindow = Number(v) || null;
    },
    setAccountUsage(v) {
      state.accountUsage = v || null;
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

function currentContextTokens(session) {
  return Math.max(
    Number(session?.lastContextTokens) || 0,
    estimateMessagesTokens(session?.messages || []),
  );
}
