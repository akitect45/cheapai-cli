import path from 'node:path';
import { t } from './theme.js';
import {
  displayWidth,
  permissionLabel,
  sanitizeTerminalText,
  shortPath,
  stripAnsi,
  wrapAnsi,
} from './draw.js';
import {
  accountBalance,
  estimateMessagesTokens,
  formatCompactCredits,
  formatTokens,
} from '../agent/usage.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const COMMANDS = [
  ['/help', 'show commands'],
  ['/status', 'session and runtime info'],
  ['/usage', 'session tokens and account spend'],
  ['/credit', 'show balance or toggle header'],
  ['/credits', 'refresh remaining credits'],
  ['/compact', 'summarize old context'],
  ['/context', 'context size and compactions'],
  ['/sessions', 'resume a saved session'],
  ['/model', 'search and switch model'],
  ['/effort', 'set reasoning intensity'],
  ['/thinking', 'toggle reasoning display'],
  ['/details', 'toggle tool details'],
  ['/goal', 'toggle goal planning mode'],
  ['/rename', 'rename current session'],
  ['/export', 'export Markdown transcript'],
  ['/ask', 'ask before writes'],
  ['/accept-edits', 'allow file edits'],
  ['/yolo', 'allow all tools'],
  ['/new', 'start a new session'],
  ['/clear', 'start a new session'],
  ['/dashboard', 'open web dashboard'],
  ['/config', 'show local configuration'],
  ['/logout', 'clear credentials and quit'],
  ['/exit', 'quit'],
  ['/quit', 'quit'],
  ['/q', 'quit'],
];

export function createFullscreenChatUi({ model, mode, effort, goalMode = false, cwd, user, sessionId, sessionTitle = '', showThinking = true, showBalance = false, messages = [], input = '', sessionUsage = {}, contextWindow = null, contextTokens = null, accountUsage = null }) {
  const state = {
    model,
    mode,
    effort,
    goalMode,
    cwd,
    user,
    sessionId,
    sessionTitle,
    entries: hydrateMessages(messages),
    input: String(input),
    cursor: [...String(input)].length,
    commandIndex: 0,
    scroll: 0,
    busy: false,
    showToolDetails: false,
    showThinking,
    showBalance,
    overlay: null,
    notice: '',
    noticeTone: 'muted',
    usage: null,
    sessionUsage: sessionUsage || {},
    contextWindow: Number(contextWindow) || null,
    contextEstimate: Math.max(Number(contextTokens) || 0, estimateMessagesTokens(messages)),
    accountUsage,
    history: userMessageHistory(messages),
    historyIndex: userMessageHistory(messages).length,
    historyDraft: '',
    frame: 0,
    activeThinking: null,
  };

  let mounted = false;
  let inputResolve = null;
  let renderTimer = null;
  let spinnerTimer = null;
  let noticeTimer = null;
  let escapeTimer = null;
  let wasRaw = false;
  let wasFlowing = null;
  let inputBuffer = '';
  let pasteMode = false;

  const PASTE_START = '\x1b[200~';
  const PASTE_END = '\x1b[201~';

  function cleanupTerminal() {
    process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l\x1b[3J');
  }

  function onExit() {
    if (mounted) {
      process.stdin.setRawMode?.(wasRaw);
      if (wasFlowing !== true) process.stdin.pause();
      cleanupTerminal();
    }
  }

  function onSigterm() {
    destroy();
    process.exit(143);
  }

  function terminate() {
    destroy();
    process.exit(130);
  }

  function mount(notice) {
    if (mounted) return;
    mounted = true;
    wasRaw = !!process.stdin.isRaw;
    wasFlowing = process.stdin.readableFlowing;
    try {
      if (notice) setNotice(notice, 'success');
      process.stdout.write('\x1b[3J\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1006h');
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', onData);
      process.stdout.on('resize', renderNow);
      process.once('exit', onExit);
      process.once('SIGTERM', onSigterm);
      spinnerTimer = setInterval(() => {
        if (!state.busy) return;
        state.frame = (state.frame + 1) % SPINNER.length;
        renderNow();
      }, 90);
      spinnerTimer.unref?.();
      renderNow();
    } catch (error) {
      destroy();
      throw error;
    }
  }

  function destroy() {
    if (!mounted) return;
    mounted = false;
    clearTimeout(renderTimer);
    clearTimeout(noticeTimer);
    clearTimeout(escapeTimer);
    clearInterval(spinnerTimer);
    process.stdin.removeListener('data', onData);
    process.stdout.removeListener('resize', renderNow);
    process.removeListener('exit', onExit);
    process.removeListener('SIGTERM', onSigterm);
    process.stdin.setRawMode?.(wasRaw);
    if (wasFlowing !== true) process.stdin.pause();
    cleanupTerminal();
  }

  function readInput() {
    state.busy = false;
    state.scroll = 0;
    renderNow();
    return new Promise((resolve) => {
      inputResolve = resolve;
    });
  }

  function submitInput() {
    if (commandSuggestions().length) completeCommand();
    const value = state.input.trim();
    if (!value || !inputResolve || state.busy) return;
    state.input = '';
    state.cursor = 0;
    if (state.history.at(-1) !== value) state.history.push(value);
    state.historyIndex = state.history.length;
    state.historyDraft = '';
    state.busy = true;
    const resolve = inputResolve;
    inputResolve = null;
    renderNow();
    resolve(value);
  }

  function onData(chunk) {
    if (!mounted) return;
    clearTimeout(escapeTimer);
    inputBuffer += chunk;
    processInputBuffer();
  }

  function processInputBuffer() {
    while (inputBuffer.length) {
      if (pasteMode) {
        const end = inputBuffer.indexOf(PASTE_END);
        if (end < 0) return;
        const pasted = inputBuffer.slice(0, end).replace(/\r\n?/g, '\n');
        inputBuffer = inputBuffer.slice(end + PASTE_END.length);
        pasteMode = false;
        if (state.overlay?.searchable) {
          state.overlay.query += clean(pasted);
          state.overlay.index = 0;
          renderNow();
        } else if (!state.overlay) {
          insertText(pasted);
        }
        continue;
      }

      if (PASTE_START.startsWith(inputBuffer) && inputBuffer.length < PASTE_START.length) {
        scheduleEscapeFlush();
        return;
      }
      if (inputBuffer.startsWith(PASTE_START)) {
        inputBuffer = inputBuffer.slice(PASTE_START.length);
        pasteMode = true;
        continue;
      }

      const mouse = readMouseSequence(inputBuffer);
      if (mouse) {
        inputBuffer = inputBuffer.slice(mouse[0].length);
        handleMouse(Number(mouse[1]), mouse[4]);
        continue;
      }

      const sequence = readEscapeSequence(inputBuffer);
      if (sequence) {
        inputBuffer = inputBuffer.slice(sequence.length);
        handleKey(sequence);
        continue;
      }
      if (isPartialEscapeSequence(inputBuffer)) {
        scheduleEscapeFlush();
        return;
      }
      if (inputBuffer === '\x1b') {
        scheduleEscapeFlush();
        return;
      }

      const char = [...inputBuffer][0];
      inputBuffer = inputBuffer.slice(char.length);
      handleKey(char);
    }
  }

  function scheduleEscapeFlush() {
    clearTimeout(escapeTimer);
    escapeTimer = setTimeout(() => {
      if (!inputBuffer.startsWith('\x1b')) return;
      if (inputBuffer !== '\x1b') {
        inputBuffer = '';
        return;
      }
      inputBuffer = inputBuffer.slice(1);
      handleKey('\x1b');
      processInputBuffer();
    }, 80);
    escapeTimer.unref?.();
  }

  function handleKey(key) {
    key = normalizeKey(key);
    if (state.overlay) {
      handleOverlayKey(key);
      return;
    }

    if (key === '\u0003') {
      terminate();
      return;
    }

    if (key === '\x1b') {
      if (state.input) {
        state.input = '';
        state.cursor = 0;
      } else {
        state.scroll = 0;
      }
      renderSoon();
      return;
    }
    if (key === '\x1b[5~') return scrollBy(viewportHeight() - 2);
    if (key === '\x1b[6~') return scrollBy(-(viewportHeight() - 2));
    if (key === '\x1b[A') return moveCommand(-1) || scrollBy(3);
    if (key === '\x1b[B') return moveCommand(1) || scrollBy(-3);
    if (state.busy) return;
    if (key === '\u0010') return moveHistory(-1);
    if (key === '\u000e') return moveHistory(1);
    if (key === '\t' && completeCommand()) return;
    if (key === '\x1b[D') return moveCursor(-1);
    if (key === '\x1b[C') return moveCursor(1);
    if (key === '\x1b[H' || key === '\u0001') return setCursor(0);
    if (key === '\x1b[F' || key === '\u0005') return setCursor([...state.input].length);
    if (key === '\x1b[3~') return deleteForward();
    if (key === '\u007f' || key === '\b') return deleteBackward();
    if (key === '\u0015') {
      state.input = '';
      state.cursor = 0;
      renderSoon();
      return;
    }
    if (key === '\r' || key === '\n') {
      submitInput();
      return;
    }
    if (key >= ' ') insertText(key);
  }

  function handleOverlayKey(key) {
    const overlay = state.overlay;
    if (key === '\u0003') {
      terminate();
      return;
    }
    if (key === '\x1b') {
      closeOverlay(null);
      return;
    }
    if (key === '\x1b[A') {
      overlay.index = (overlay.index - 1 + filteredOptions(overlay).length) % Math.max(1, filteredOptions(overlay).length);
      renderNow();
      return;
    }
    if (key === '\x1b[B') {
      overlay.index = (overlay.index + 1) % Math.max(1, filteredOptions(overlay).length);
      renderNow();
      return;
    }
    if (key === '\r' || key === '\n') {
      const options = filteredOptions(overlay);
      closeOverlay(options[overlay.index] || null);
      return;
    }
    if (overlay.searchable && (key === '\u007f' || key === '\b')) {
      overlay.query = overlay.query.slice(0, -1);
      overlay.index = 0;
      renderNow();
      return;
    }
    if (overlay.searchable && key === '\u0015') {
      overlay.query = '';
      overlay.index = 0;
      renderNow();
      return;
    }
    if (overlay.searchable && key >= ' ') {
      overlay.query += key;
      overlay.index = 0;
      renderNow();
    }
  }

  function handleMouse(button, action) {
    if (state.overlay || action !== 'M' || (button & 64) === 0) return;
    const amount = Math.max(3, Math.floor(viewportHeight() / 4));
    scrollBy((button & 1) === 0 ? amount : -amount);
  }

  function insertText(value) {
    const chars = [...state.input];
    chars.splice(state.cursor, 0, ...[...value]);
    state.input = chars.join('');
    state.cursor += [...value].length;
    state.commandIndex = 0;
    renderSoon();
  }

  function moveCursor(amount) {
    setCursor(state.cursor + amount);
  }

  function setCursor(value) {
    state.cursor = Math.max(0, Math.min([...state.input].length, value));
    renderSoon();
  }

  function deleteBackward() {
    if (!state.cursor) return;
    const chars = [...state.input];
    chars.splice(state.cursor - 1, 1);
    state.input = chars.join('');
    state.cursor -= 1;
    state.commandIndex = 0;
    renderSoon();
  }

  function deleteForward() {
    const chars = [...state.input];
    if (state.cursor >= chars.length) return;
    chars.splice(state.cursor, 1);
    state.input = chars.join('');
    state.commandIndex = 0;
    renderSoon();
  }

  function commandSuggestions() {
    if (!/^\/[^\s]*$/.test(state.input)) return [];
    const query = state.input.slice(1).toLowerCase();
    return COMMANDS.filter(([command]) => command.slice(1).startsWith(query)).slice(0, 5);
  }

  function moveCommand(amount) {
    const suggestions = commandSuggestions();
    if (!suggestions.length || state.busy) return false;
    state.commandIndex = (state.commandIndex + amount + suggestions.length) % suggestions.length;
    renderSoon();
    return true;
  }

  function completeCommand() {
    const suggestions = commandSuggestions();
    if (!suggestions.length || state.busy) return false;
    const [command] = suggestions[Math.min(state.commandIndex, suggestions.length - 1)];
    state.input = command;
    state.cursor = [...command].length;
    state.commandIndex = 0;
    renderSoon();
    return true;
  }

  function moveHistory(amount) {
    if (!state.history.length) return;
    if (state.historyIndex === state.history.length) state.historyDraft = state.input;
    state.historyIndex = Math.max(0, Math.min(state.history.length, state.historyIndex + amount));
    state.input = state.historyIndex === state.history.length
      ? state.historyDraft
      : state.history[state.historyIndex];
    state.cursor = [...state.input].length;
    state.commandIndex = 0;
    renderSoon();
  }

  function stopThinking() {
    if (state.activeThinking) state.activeThinking.active = false;
    state.activeThinking = null;
  }

  function scrollBy(amount) {
    state.scroll = Math.max(0, state.scroll + amount);
    renderNow();
  }

  function pick({ title, subtitle, options, initialIndex = 0, searchable = false }) {
    return new Promise((resolve) => {
      state.overlay = {
        type: 'picker',
        title,
        subtitle,
        options: options.map((option) => ({ ...option, label: sanitizeTerminalText(option.label), hint: sanitizeTerminalText(option.hint || '') })),
        index: Math.max(0, initialIndex),
        query: '',
        searchable,
        resolve,
      };
      renderNow();
    });
  }

  async function requestPermission(toolName, detail) {
    const label = toolLabel(toolName);
    const choice = await pick({
      title: `Permission · ${label}`,
      subtitle: sanitizeTerminalText(detail),
      options: [
        { label: 'Allow once', hint: 'Run this operation', action: true },
        { label: 'Allow always', hint: 'All tools until exit', action: 'always' },
        { label: 'Reject', hint: 'Do not run', action: false },
      ],
    });
    if (choice !== 'always') return choice === true;
    const confirm = await pick({
      title: 'Allow all tools until exit?',
      subtitle: 'Bash commands and file edits will no longer ask for approval.',
      options: [
        { label: 'Confirm allow always', action: 'always' },
        { label: 'Cancel', action: false },
      ],
      initialIndex: 1,
    });
    return confirm === 'always' ? 'always' : false;
  }

  function closeOverlay(option) {
    const overlay = state.overlay;
    state.overlay = null;
    renderNow();
    overlay.resolve(option ? option.action ?? option : overlay.type === 'permission' ? false : null);
  }

  function filteredOptions(overlay) {
    if (!overlay.searchable || !overlay.query) return overlay.options;
    const query = overlay.query.toLowerCase();
    return overlay.options.filter((option) => `${option.label} ${option.hint}`.toLowerCase().includes(query));
  }

  function writeUser(text) {
    state.entries.push({ type: 'user', text: String(text) });
    state.contextEstimate += Math.ceil(String(text).length / 4) + 12;
    state.scroll = 0;
    state.busy = true;
    renderSoon();
  }

  function writeUsage(usage, sessionUsage, contextWindow, contextTokens) {
    state.usage = usage;
    if (sessionUsage) state.sessionUsage = sessionUsage;
    if (contextWindow != null) state.contextWindow = Number(contextWindow) || null;
    if (contextTokens != null) state.contextEstimate = Number(contextTokens) || state.contextEstimate;
    const assistant = [...state.entries].reverse().find((entry) => entry.type === 'assistant');
    if (assistant) assistant.usage = usage;
    renderSoon();
  }

  function writeContext(notice) {
    if (notice) setNotice(notice, 'success');
    renderNow();
  }

  function addNotice(text, tone = 'muted') {
    state.entries.push({ type: 'notice', text: String(text), tone });
    state.scroll = 0;
    renderSoon();
  }

  function showInfo(title, rows) {
    state.entries.push({ type: 'info', title, rows });
    state.scroll = 0;
    renderSoon();
  }

  function setNotice(text, tone = 'muted') {
    state.notice = String(text || '');
    state.noticeTone = tone;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      state.notice = '';
      renderSoon();
    }, 3200);
    noticeTimer.unref?.();
    renderSoon();
  }

  function setBusy(value) {
    state.busy = !!value;
    renderSoon();
  }

  function resetSession(sessionId, title = '', notice = '', messages = []) {
    state.sessionId = sessionId;
    state.sessionTitle = title;
    state.entries = hydrateMessages(messages);
    state.usage = null;
    state.contextEstimate = estimateMessagesTokens(messages);
    state.scroll = 0;
    state.input = '';
    state.cursor = 0;
    state.commandIndex = 0;
    state.history = userMessageHistory(messages);
    state.historyIndex = state.history.length;
    state.historyDraft = '';
    state.activeThinking = null;
    if (notice) setNotice(notice, 'success');
    renderNow();
  }

  function agentHooks() {
    return {
      onThinking(turn) {
        if (state.activeThinking) state.activeThinking.active = false;
        const entry = { type: 'thinking', turn, text: '', active: true };
        state.entries.push(entry);
        state.activeThinking = entry;
        renderSoon();
      },
      onReasoningDelta(text) {
        let entry = state.entries.at(-1);
        if (!entry || entry.type !== 'thinking') {
          entry = { type: 'thinking', turn: null, text: '' };
          state.entries.push(entry);
        }
        entry.text += text;
        renderSoon();
      },
      onAssistantStart() {
        stopThinking();
        state.entries.push({ type: 'assistant', text: '', startedAt: Date.now() });
        renderSoon();
      },
      onDelta(text) {
        let entry = state.entries.at(-1);
        if (!entry || entry.type !== 'assistant') {
          entry = { type: 'assistant', text: '', startedAt: Date.now() };
          state.entries.push(entry);
        }
        entry.text += text;
        renderSoon();
      },
      onAssistantEnd() {
        stopThinking();
        const entry = [...state.entries].reverse().find((item) => item.type === 'assistant' && !item.completedAt);
        if (entry) entry.completedAt = Date.now();
        renderSoon();
      },
      onToolPending() {},
      onToolStart(name, detail) {
        stopThinking();
        state.entries.push({ type: 'tool', name, detail, status: 'running', result: null });
        renderSoon();
      },
      onToolEnd(name, detail, status, result) {
        let entry = [...state.entries].reverse().find((item) => item.type === 'tool' && item.status === 'running');
        if (!entry) {
          entry = { type: 'tool', name, detail, status, result };
          state.entries.push(entry);
        } else {
          Object.assign(entry, { name, detail, status, result });
        }
        renderSoon();
      },
      onTodo(todos) {
        state.entries.push({ type: 'todo', todos });
        renderSoon();
      },
    };
  }

  function renderSoon() {
    if (!mounted || renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderNow();
    }, 16);
  }

  function renderNow() {
    if (!mounted) return;
    const width = Math.max(1, process.stdout.columns || 80);
    const height = Math.max(1, process.stdout.rows || 24);
    const frame = renderFrame(width, height);
    const cursor = cursorPosition(width, height);
    process.stdout.write(`\x1b[H${frame}\x1b[J${cursor ? `\x1b[${cursor.row};${cursor.column}H\x1b[?25h` : '\x1b[?25l'}`);
  }

  function cursorPosition(width, height) {
    if (state.busy || state.overlay || width < 20 || height < 12) return null;
    const contentWidth = Math.max(18, Math.min(width - 4, 100));
    const left = Math.max(1, Math.floor((width - contentWidth) / 2));
    const suggestions = commandSuggestions();
    const bodyWidth = Math.max(8, contentWidth - 4);
    const before = [...state.input].slice(0, state.cursor).join('');
    const beforeLines = wrapAnsi(before, bodyWidth);
    const line = beforeLines.at(-1) || '';
    const composerLength = renderComposer(contentWidth).length;
    const composerTop = Math.max(5, height - composerLength);
    const lineOffset = Math.min(1, Math.max(0, beforeLines.length - 1));
    return {
      row: Math.min(height, composerTop + suggestions.length + 2 + lineOffset),
      column: Math.max(1, Math.min(width - 1, left + 3 + displayWidth(line))),
    };
  }

  function renderFrame(width, height) {
    if (width < 20 || height < 12) return renderTinyFrame(width, height);
    const screen = Array.from({ length: height }, () => '');
    const contentWidth = Math.max(18, Math.min(width - 4, 100));
    const left = Math.max(1, Math.floor((width - contentWidth) / 2));

    renderHeader(screen, width, contentWidth, left);
    const composer = renderComposer(contentWidth);
    const composerTop = Math.max(5, height - composer.length);
    const viewTop = 3;
    const viewHeight = Math.max(1, composerTop - viewTop - 1);
    const body = state.entries.length ? renderEntries(contentWidth) : renderWelcome(contentWidth, viewHeight);
    const maxScroll = Math.max(0, body.length - viewHeight);
    state.scroll = Math.min(state.scroll, maxScroll);
    const start = Math.max(0, body.length - viewHeight - state.scroll);
    const visible = body.slice(start, start + viewHeight);
    for (let i = 0; i < visible.length; i++) screen[viewTop + i] = offsetLine(visible[i], left);
    for (let i = 0; i < composer.length; i++) screen[composerTop + i] = offsetLine(composer[i], left);
    renderScrollBar(screen, viewTop, viewHeight, left, contentWidth, width, body.length, maxScroll);

    if (state.overlay) renderOverlay(screen, width, height, contentWidth);
    return screen.map((line) => padLine(line, width)).join('\n');
  }

  function renderScrollBar(screen, top, height, left, contentWidth, width, totalLines, maxScroll) {
    if (maxScroll <= 0 || height < 3) return;
    const column = Math.min(width - 2, left + contentWidth + 1);
    const thumbHeight = Math.max(1, Math.round((height * height) / totalLines));
    const travel = Math.max(0, height - thumbHeight);
    const fromTop = travel - Math.round((state.scroll / maxScroll) * travel);
    for (let index = 0; index < height; index++) {
      const row = top + index;
      const line = screen[row] || '';
      const gap = Math.max(0, column - displayWidth(line));
      const mark = index >= fromTop && index < fromTop + thumbHeight ? t.accent('┃') : t.border('│');
      screen[row] = `${line}${' '.repeat(gap)}${mark}`;
    }
  }

  function renderTinyFrame(width, height) {
    const screen = Array.from({ length: height }, () => '');
    const row = Math.max(0, Math.floor(height / 2));
    screen[row] = centerLine(clipCells(width < 12 ? 'cheapai' : 'Resize terminal', width), width);
    return screen.map((line) => padLine(line, width)).join('\n');
  }

  function renderHeader(screen, width, contentWidth, left) {
    const project = clean(path.basename(state.cwd) || shortPath(state.cwd));
    const leftText = `${t.bold(t.accent('◆ cheapai'))} ${t.dim('/')} ${t.white(clipCells(project, Math.max(8, Math.floor(contentWidth * 0.35))))}`;
    const busy = state.busy ? `${t.yellow(SPINNER[state.frame])} ${t.dim('working')}` : t.green('● ready');
    const workspaceMode = state.goalMode ? t.magenta('goal · plan only') : permissionLabel(state.mode);
    const rightText = `${t.cyan(clipCells(clean(state.model), Math.max(8, Math.floor(contentWidth * 0.3))))}  ${workspaceMode}`;
    screen[0] = offsetLine(joinSides(leftText, rightText, contentWidth), left);
    const subtitle = clean(state.sessionTitle || `session ${state.sessionId.slice(0, 8)}`);
    const details = [busy];
    if (state.effort && state.effort !== 'off') details.push(t.dim(`effort ${state.effort}`));
    const balance = accountBalance(state.accountUsage);
    if (state.showBalance && balance != null) details.push(t.green(`₩${formatCompactCredits(balance)}`));
    const estimated = state.contextEstimate;
    if (estimated) {
      const context = state.contextWindow
        ? `ctx ${Math.min(999, Math.round((estimated / state.contextWindow) * 100))}%`
        : `ctx ${formatTokens(estimated)}`;
      details.push(t.dim(context));
    }
    const meta = details.join(t.dim('  ·  '));
    screen[1] = offsetLine(joinSides(t.dim(clipCells(subtitle, Math.max(8, contentWidth - 28))), meta, contentWidth), left);
    screen[2] = offsetLine(t.border('─'.repeat(contentWidth)), left);
  }

  function renderWelcome(width, height) {
    const logo = width >= 56
      ? [
          `${t.accent('█▀▀ █ █ █▀▀ ▄▀█ █▀█')} ${t.gray('  ▄▀█ █')}`,
          `${t.accent('█▄▄ █▀█ ██▄ █▀█ █▀▀')} ${t.gray('  █▀█ █')}`,
        ]
      : [t.bold(t.accent('cheap')) + t.bold(t.gray('ai'))];
    const heading = width < 34 ? 'Ready to build?' : 'What do you want to build?';
    const description = width < 38 ? 'Ask about the code or give me a task.' : 'Describe a task, ask about the codebase, or type /help.';
    const lines = [
      ...logo,
      '',
      t.bold(t.white(heading)),
      t.dim(description),
    ];
    if (height >= 13 && width >= 52) {
      lines.push('', `${t.dim('Try')}  ${t.white('Explain this project')}  ${t.dim('·')}  ${t.white('Fix a bug')}  ${t.dim('·')}  ${t.white('Add a feature')}`);
    }
    const top = Math.max(0, Math.floor((height - lines.length) / 2) - 1);
    return [...Array(top).fill(''), ...lines.map((line) => centerLine(line, width))];
  }

  function renderEntries(width) {
    const lines = [];
    for (const entry of state.entries) {
      if (entry.type === 'user') renderUser(lines, entry, width);
      else if (entry.type === 'assistant') renderAssistant(lines, entry, width);
      else if (entry.type === 'thinking' && state.showThinking) renderThinking(lines, entry, width);
      else if (entry.type === 'tool') renderTool(lines, entry, width);
      else if (entry.type === 'notice') renderNotice(lines, entry, width);
      else if (entry.type === 'info') renderInfo(lines, entry, width);
      else if (entry.type === 'todo') renderTodo(lines, entry, width);
    }
    return lines;
  }

  function renderUser(lines, entry, width) {
    lines.push('');
    const body = safeWrap(entry.text, width - 4);
    for (const line of body) lines.push(`${t.user('▌')} ${line}`);
  }

  function renderAssistant(lines, entry, width) {
    lines.push('');
    const body = safeWrap(entry.text || (state.busy ? '…' : ''), width - 4);
    body.forEach((line, index) => lines.push(`${index === 0 ? t.accent('✦') : ' '}  ${t.agent(line)}`));
    if (entry.completedAt || entry.usage) {
      const elapsed = entry.completedAt && entry.startedAt ? ` · ${((entry.completedAt - entry.startedAt) / 1000).toFixed(1)}s` : '';
      const usage = entry.usage ? ` · ${formatTokens(entry.usage.prompt_tokens || 0)} in / ${formatTokens(entry.usage.completion_tokens || 0)} out` : '';
      const costValue = entry.usage?.cost_credits ?? entry.usage?.cost_krw;
      const cost = Number(costValue) > 0 ? ` · ₩${formatCompactCredits(costValue)}` : '';
      lines.push(t.dim(`   ${state.model}${elapsed}${usage}${cost}`));
    }
  }

  function renderThinking(lines, entry, width) {
    if (entry.active && state.busy) {
      const dot = state.frame < SPINNER.length / 2 ? t.yellow('●') : ' ';
      lines.push('', `${dot}  ${t.dim(`Thinking${entry.turn ? ` · turn ${entry.turn}` : ''}`)}`);
    } else {
      lines.push('', `${t.yellow('┊')} ${t.dim(`Thinking${entry.turn ? ` · turn ${entry.turn}` : ''}`)}`);
    }
    if (state.showToolDetails && entry.text) {
      for (const line of safeWrap(entry.text, width - 4).slice(-8)) lines.push(`${t.border('┊')} ${t.dim(line)}`);
    }
  }

  function renderTool(lines, entry, width) {
    const mark = entry.status === 'running' ? t.yellow('●') : entry.status === 'ok' ? t.green('✓') : t.red('✗');
    const label = t.tool(toolLabel(entry.name));
    const summary = toolSummary(entry);
    lines.push(`${t.border(entry.status === 'running' ? '├─' : '╰─')} ${mark} ${label}${summary ? `  ${t.dim(clipCells(summary, Math.max(8, width - 20)))}` : ''}`);
    if (state.showToolDetails || entry.status === 'error' || entry.status === 'denied') {
      const detail = [entry.detail, resultDetail(entry.result)].filter(Boolean).join(' · ');
      for (const line of safeWrap(detail, width - 4).slice(0, 10)) lines.push(`${t.border('│')}  ${entry.status === 'error' ? t.red(line) : t.dim(line)}`);
    }
  }

  function renderNotice(lines, entry, width) {
    lines.push('');
    const paint = entry.tone === 'error' ? t.red : entry.tone === 'warning' ? t.yellow : entry.tone === 'success' ? t.green : t.dim;
    for (const line of safeWrap(entry.text, width - 3)) lines.push(`${paint('•')} ${paint(line)}`);
  }

  function renderInfo(lines, entry, width) {
    lines.push('', t.bold(t.white(clean(entry.title))));
    for (const row of entry.rows || []) {
      if (Array.isArray(row)) {
        const [key, value] = row;
        lines.push(`${t.dim(clean(key).padEnd(12))} ${clipCells(clean(value ?? '—'), width - 14)}`);
      } else {
        for (const line of safeWrap(row, width)) lines.push(line);
      }
    }
  }

  function renderTodo(lines, entry, width) {
    lines.push('', t.bold('Tasks'));
    for (const todo of entry.todos || []) {
      const mark = todo.status === 'completed' ? t.green('✓') : todo.status === 'in_progress' ? t.yellow('●') : t.dim('○');
      lines.push(`${mark} ${clipCells(clean(todo.content || todo.id || ''), width - 3)}`);
    }
  }

  function renderComposer(width) {
    const bodyWidth = Math.max(8, width - 4);
    const cursorText = inputWithCursor();
    let inputLines = state.input ? wrapAnsi(cursorText, bodyWidth) : [state.busy ? t.dim('Working…') : t.dim('Ask anything…')];
    inputLines = inputLines.slice(-2);
    while (inputLines.length < 2) inputLines.push('');
    const border = state.busy ? t.border : t.accent;
    const out = renderCommandSuggestions(width);
    out.push(border(`╭${'─'.repeat(width - 2)}╮`));
    for (const line of inputLines) out.push(`${border('│')} ${line}${' '.repeat(Math.max(0, bodyWidth - displayWidth(line)))} ${border('│')}`);
    out.push(border(`╰${'─'.repeat(width - 2)}╯`));
    const mode = state.goalMode
      ? t.magenta('goal · plan only')
      : state.mode === 'yolo'
        ? t.yellow('all tools')
        : state.mode === 'accept-edits'
          ? t.cyan('edits allowed')
          : t.dim('ask for writes');
    out.push(joinSides(`${t.accent('build')}  ${t.dim(state.model)}`, mode, width));
    const notice = state.notice ? paintNotice(state.notice, state.noticeTone) : t.dim('Enter send  ·  / commands  ·  PgUp scroll  ·  Ctrl+C exit');
    out.push(clipStyled(notice, width));
    return out;
  }

  function inputWithCursor() {
    const chars = [...state.input];
    const before = chars.slice(0, state.cursor).join('');
    const current = chars[state.cursor] || ' ';
    const after = chars.slice(state.cursor + (chars[state.cursor] ? 1 : 0)).join('');
    return `${before}${current}${after}`;
  }

  function renderCommandSuggestions(width) {
    const suggestions = commandSuggestions();
    if (!suggestions.length) return [];
    state.commandIndex = Math.min(state.commandIndex, suggestions.length - 1);
    return suggestions.map(([command, description], index) => {
      const marker = index === state.commandIndex ? t.accent('▌') : ' ';
      const label = index === state.commandIndex ? t.bold(command) : command;
      return clipStyled(`${marker} ${label}  ${t.dim(description)}`, width);
    });
  }

  function renderOverlay(screen, width, height, contentWidth) {
    const overlay = state.overlay;
    const options = filteredOptions(overlay);
    overlay.index = Math.max(0, Math.min(overlay.index, Math.max(0, options.length - 1)));
    const boxWidth = Math.max(16, Math.min(contentWidth, 72));
    const fixedRows = 4 + (overlay.subtitle ? 1 : 0) + (overlay.searchable ? 1 : 0);
    const maxOptions = Math.max(1, Math.min(8, height - fixedRows - 2));
    const start = Math.max(0, Math.min(overlay.index - Math.floor(maxOptions / 2), options.length - maxOptions));
    const visible = options.slice(start, start + maxOptions);
    const rows = [t.bold(t.white(clipCells(overlay.title || 'Select', boxWidth - 4)))];
    if (overlay.subtitle) rows.push(t.dim(clipCells(overlay.subtitle, boxWidth - 4)));
    if (overlay.searchable) rows.push(`${t.accent('/')} ${overlay.query || t.dim('type to filter')}`);
    rows.push(t.border('─'.repeat(boxWidth - 4)));
    if (!visible.length) rows.push(t.dim('No matches'));
    visible.forEach((option, visibleIndex) => {
      const index = start + visibleIndex;
      const selected = index === overlay.index;
      const prefix = selected ? t.accent('▌') : ' ';
      const label = selected ? t.bold(option.label) : option.label;
      const hint = option.hint ? t.dim(`  ${clipCells(option.hint, Math.max(6, boxWidth - displayWidth(option.label) - 9))}`) : '';
      rows.push(`${prefix} ${clipStyled(label + hint, boxWidth - 4)}`);
    });
    rows.push('', t.dim('↑/↓ move  ·  Enter select  ·  Esc cancel'));

    const top = Math.max(0, Math.floor((height - rows.length - 2) / 2));
    const left = Math.max(0, Math.floor((width - boxWidth) / 2));
    screen[top] = offsetLine(t.border(`╭${'─'.repeat(boxWidth - 2)}╮`), left);
    rows.forEach((row, index) => {
      const padded = row + ' '.repeat(Math.max(0, boxWidth - 4 - displayWidth(row)));
      screen[top + index + 1] = offsetLine(`${t.border('│')} ${padded} ${t.border('│')}`, left);
    });
    screen[top + rows.length + 1] = offsetLine(t.border(`╰${'─'.repeat(boxWidth - 2)}╯`), left);
  }

  function viewportHeight() {
    return Math.max(4, (process.stdout.rows || 24) - 11);
  }

  return {
    isFullscreen: true,
    mount,
    destroy,
    readInput,
    pick,
    requestPermission,
    writeUser,
    writeUsage,
    writeContext,
    addNotice,
    showInfo,
    setBusy,
    resetSession,
    renderSnapshot(columns = 80, rows = 24) {
      return renderFrame(Math.max(1, columns), Math.max(1, rows));
    },
    agentHooks,
    get model() { return state.model; },
    set model(value) { state.model = value; renderSoon(); },
    get mode() { return state.mode; },
    set mode(value) { state.mode = value; renderSoon(); },
    get effort() { return state.effort; },
    set effort(value) { state.effort = value; renderSoon(); },
    set sessionId(value) { state.sessionId = value; renderSoon(); },
    set sessionTitle(value) { state.sessionTitle = value || ''; renderSoon(); },
    setToolDetails(value) { state.showToolDetails = !!value; renderSoon(); },
    setThinkingVisible(value) { state.showThinking = !!value; renderSoon(); },
    setGoalMode(value) { state.goalMode = !!value; renderSoon(); },
    setSessionUsage(value, contextWindow, contextTokens) {
      state.sessionUsage = value || {};
      if (contextTokens != null) state.contextEstimate = Number(contextTokens) || state.contextEstimate;
      if (contextWindow != null) state.contextWindow = Number(contextWindow) || null;
      renderSoon();
    },
    setContextWindow(value) { state.contextWindow = Number(value) || null; renderSoon(); },
    setAccountUsage(value) { state.accountUsage = value || null; renderSoon(); },
    setShowBalance(value) { state.showBalance = !!value; renderSoon(); },
  };
}

function safeWrap(value, width) {
  const text = stripAnsi(String(value || '')).replace(/\r/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ' ');
  return wrapAnsi(text, Math.max(1, width));
}

function readEscapeSequence(value) {
  if (!value.startsWith('\x1b') || value.length < 2) return null;
  if (value.startsWith('\x1b[')) return value.match(/^\x1b\[[0-?]*[ -/]*[@-~]/)?.[0] || null;
  if (value.startsWith('\x1bO')) return value.match(/^\x1bO[ -~]/)?.[0] || null;
  return '\x1b';
}

function readMouseSequence(value) {
  return value.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
}

function isPartialEscapeSequence(value) {
  return value === '\x1b' || value.startsWith('\x1b[') || value.startsWith('\x1bO');
}

function normalizeKey(key) {
  if (key === '\x1bOA') return '\x1b[A';
  if (key === '\x1bOB') return '\x1b[B';
  if (key === '\x1bOC') return '\x1b[C';
  if (key === '\x1bOD') return '\x1b[D';
  if (key === '\x1bOH') return '\x1b[H';
  if (key === '\x1bOF') return '\x1b[F';
  const match = key.match(/^\x1b\[(\d+)(?:;[^~]*)?~$/);
  if (!match) return key;
  if (match[1] === '1' || match[1] === '7') return '\x1b[H';
  if (match[1] === '4' || match[1] === '8') return '\x1b[F';
  return key;
}

function joinSides(left, right, width) {
  const rightWidth = displayWidth(right);
  if (rightWidth >= width) return clipStyled(right, width);
  const safeLeft = clipStyled(left, Math.max(1, width - rightWidth - 2));
  const gap = Math.max(1, width - displayWidth(safeLeft) - rightWidth);
  return `${safeLeft}${' '.repeat(gap)}${right}`;
}

function centerLine(line, width) {
  return `${' '.repeat(Math.max(0, Math.floor((width - displayWidth(line)) / 2)))}${line}`;
}

function offsetLine(line, offset) {
  return `${' '.repeat(Math.max(0, offset))}${line}`;
}

function padLine(line, width) {
  // Leave the terminal's last column unused so wide-character input cannot trigger auto-wrap.
  const safeWidth = Math.max(1, width - 1);
  const clipped = clipStyled(line, safeWidth);
  return `${clipped}${' '.repeat(Math.max(0, safeWidth - displayWidth(clipped)))}`;
}

function clipStyled(value, maxWidth) {
  const text = String(value || '');
  if (displayWidth(text) <= maxWidth) return text;
  return clipCells(stripAnsi(text), maxWidth);
}

function clipCells(value, maxWidth) {
  const text = String(value || '');
  if (displayWidth(text) <= maxWidth) return text;
  let out = '';
  for (const char of text) {
    if (displayWidth(`${out}${char}…`) > maxWidth) break;
    out += char;
  }
  return `${out}…`;
}

function paintNotice(value, tone) {
  if (tone === 'error') return t.red(value);
  if (tone === 'warning') return t.yellow(value);
  if (tone === 'success') return t.green(value);
  return t.dim(value);
}

function toolLabel(name) {
  return ({ bash: 'Bash', read_file: 'Read', write_file: 'Write', edit_file: 'Edit', glob: 'Glob', grep: 'Grep', todo_write: 'Tasks' })[name] || clean(name);
}

function toolSummary(entry) {
  if (entry.result?.error) return String(entry.result.error);
  if (entry.result?.path) return shortPath(entry.result.path);
  if (Array.isArray(entry.result?.files)) return `${entry.result.files.length} files`;
  if (Array.isArray(entry.result?.matches)) return `${entry.result.matches.length} matches`;
  if (entry.result?.stdout || entry.result?.stderr) {
    return sanitizeTerminalText(entry.result.stderr || entry.result.stdout).slice(0, 120);
  }
  return sanitizeTerminalText(entry.detail || '');
}

function resultDetail(result) {
  if (!result) return '';
  if (result.error) return `error: ${result.error}`;
  if (result.stderr) return result.stderr;
  if (result.stdout) return result.stdout;
  return '';
}

function clean(value) {
  return sanitizeTerminalText(String(value ?? ''));
}

function hydrateMessages(messages) {
  const entries = [];
  for (const message of messages || []) {
    if (message?.role === 'user' && message.content) {
      entries.push({ type: 'user', text: String(message.content) });
    } else if (message?.role === 'assistant' && message.content) {
      entries.push({ type: 'assistant', text: String(message.content), completedAt: Date.now() });
    }
  }
  return entries;
}

function userMessageHistory(messages) {
  return (messages || [])
    .filter((message) => message?.role === 'user' && message.content && !String(message.content).startsWith('[Previous conversation summary]'))
    .map((message) => String(message.content))
    .slice(-100);
}
