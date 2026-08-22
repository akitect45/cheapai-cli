import path from 'node:path';
import { t } from './theme.js';
import {
  displayWidth,
  formatMarkdown,
  formatTabTitle,
  iterateGraphemes,
  paintInverseCells,
  permissionLabel,
  sanitizeTerminalText,
  shortPath,
  sliceByCells,
  statusBanner,
  stripAnsi,
  wrapAnsi,
  writeTerminalTitle,
  formatElapsed,
} from './draw.js';
import { paintDiffLines } from './diff.js';
import { copyText } from './clipboard.js';
import {
  accountBalance,
  estimateMessagesTokens,
  formatCompactCredits,
  formatTokens,
} from '../agent/usage.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TRANSIENT_ENTRY_TTL_MS = 60_000;
/** Composer grows with wrapped input up to this many rows, then scrolls. */
const COMPOSER_MAX_LINES = 4;
/** Keep ≥2 so empty placeholder → first keystroke does not resize the frame. */
const COMPOSER_MIN_LINES = 2;
const COMMANDS = [
  ['/help', 'show commands'],
  ['/status', 'session and runtime info'],
  ['/usage', 'session tokens and account spend'],
  ['/credits', 'show credits or toggle header'],
  ['/compact', 'summarize old context'],
  ['/undo', 'undo last turn and tracked edits'],
  ['/redo', 'restore last undone turn'],
  ['/fork', 'fork current session'],
  ['/retry', 'undo and rerun last prompt'],
  ['/copy', 'copy last assistant answer'],
  ['/search', 'search current transcript'],
  ['/context', 'context size and compactions'],
  ['/sessions', 'resume or delete a saved session'],
  ['/model', 'pick model, then effort'],
  ['/agent', 'switch agent profile'],
  ['/effort', 'set reasoning intensity'],
  ['/turn', 'max tool loops (0 = unlimited)'],
  ['/thinking', 'toggle reasoning display'],
  ['/details', 'toggle tool details'],
  ['/goal', 'toggle goal planning mode'],
  ['/docs', 'toggle project documentation mode'],
  ['/rename', 'rename current session'],
  ['/export', 'export Markdown transcript'],
  ['/ask', 'ask before writes'],
  ['/accept-edits', 'allow file edits'],
  ['/yolo', 'allow all tools'],
  ['/new', 'start a new session'],
  ['/clear', 'start a new session'],
  ['/dashboard', 'open web dashboard'],
  ['/config', 'show local configuration'],
  ['/update', 'install the latest published version'],
  ['/logout', 'clear credentials and quit'],
  ['/exit', 'quit'],
  ['/quit', 'quit'],
  ['/q', 'quit'],
];

export function createFullscreenChatUi({ model, mode, effort, agent = 'build', goalMode = false, cwd, user, sessionId, sessionTitle = '', showThinking = true, showBalance = false, commands = [], messages = [], input = '', sessionUsage = {}, contextWindow = null, contextTokens = null, accountUsage = null }) {
  const state = {
    model,
    mode,
    effort,
    agent,
    goalMode,
    cwd,
    user,
    sessionId,
    sessionTitle,
    entries: hydrateMessages(messages),
    input: String(input),
    // Cursor is a grapheme-cluster index (not UTF-16 code units).
    cursor: iterateGraphemes(String(input)).length,
    commandIndex: 0,
    scroll: 0,
    busy: false,
    busyStartedAt: 0,
    busyActivity: '',
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
    commands: [...COMMANDS, ...commands.map((command) => [`/${command.name}`, command.description])],
    history: userMessageHistory(messages),
    historyIndex: userMessageHistory(messages).length,
    historyDraft: '',
    frame: 0,
    activeThinking: null,
    /** @type {{ entryIndex: number, start: number, end: number }[]} */
    hitZones: [],
    /** Follow-ups queued while the agent is working */
    pendingQueue: [],
    followups: [],
    /** Vertical scroll offset inside the multi-line composer (visual lines). */
    inputScroll: 0,
    /**
     * 1-based screen geometry of the composer input body (wheel + drag select).
     * @type {null | { first: number, last: number, contentLeft: number, bodyWidth: number }}
     */
    composerInputHit: null,
    /** Grapheme index anchor for drag/shift selection; null = no selection. */
    selectAnchor: null,
    /**
     * Grok-style dual focus: prompt (composer) vs scrollback (conversation).
     * @type {'prompt' | 'scrollback'}
     */
    focus: 'prompt',
    /** Index into state.entries of the highlighted scrollback block. */
    selectedEntry: -1,
    /** @type {{ index: number, start: number, end: number }[]} */
    entryRanges: [],
    /** @type {null | { first: number, last: number }} */
    chatHit: null,
    viewportMeta: null,
    /**
     * Character-level scrollback selection (body line + display-cell columns).
     * @type {null | { line: number, col: number }}
     */
    chatSelAnchor: null,
    /** @type {null | { line: number, col: number }} */
    chatSelEnd: null,
    /** Last rendered body lines (styled) for selection paint/copy. */
    bodyCache: null,
    /** Geometry of the last painted composer (for stable caret placement). */
    composerGeom: null,
  };

  /** @type {null | ((payload: { text: string, mode: 'queue' | 'promote' }) => boolean | void)} */
  let busySubmitHandler = null;
  let inputDragging = false;
  let chatDragging = false;

  let mounted = false;
  let inputResolve = null;
  let renderTimer = null;
  let spinnerTimer = null;
  let noticeTimer = null;
  let transientTimer = null;
  let escapeTimer = null;
  let wasRaw = false;
  let wasFlowing = null;
  let inputBuffer = '';
  let pasteMode = false;
  let abortHandler = null;
  let lastTabTitle = null;
  let pendingExit = false;
  let pendingExitTimer = null;
  /** @type {string[] | null} last painted screen rows (for dirty-line updates) */
  let lastPaintedLines = null;
  let lastPaintedWidth = 0;
  let lastPaintedHeight = 0;
  const EXIT_HINT = 'Press Ctrl+C again to exit';

  const PASTE_START = '\x1b[200~';
  const PASTE_END = '\x1b[201~';

  /** Grapheme clusters in the composer — keeps Korean jamo / emoji cursor-stable. */
  function inputChars() {
    return iterateGraphemes(state.input);
  }

  function invalidatePaintCache() {
    lastPaintedLines = null;
    lastPaintedWidth = 0;
    lastPaintedHeight = 0;
  }

  function cleanupTerminal() {
    lastTabTitle = null;
    invalidatePaintCache();
    writeTerminalTitle('cheapai');
    process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1007l\x1b[?2004l\x1b[?25h\x1b[?1049l\x1b[3J');
  }

  function sessionLabelForTitle() {
    return clean(state.sessionTitle || (state.sessionId ? state.sessionId.slice(0, 8) : '') || path.basename(state.cwd) || 'session');
  }

  function syncTabTitle() {
    const next = formatTabTitle({
      busy: state.busy,
      thinking: !!state.activeThinking,
      sessionLabel: sessionLabelForTitle(),
      frame: state.frame,
    });
    if (next === lastTabTitle) return;
    lastTabTitle = next;
    writeTerminalTitle(next);
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

  function clearPendingExit({ clearNotice = false } = {}) {
    const wasPending = pendingExit || (clearNotice && state.notice === EXIT_HINT);
    pendingExit = false;
    clearTimeout(pendingExitTimer);
    pendingExitTimer = null;
    if (clearNotice && state.notice === EXIT_HINT) {
      state.notice = '';
      state.noticeTone = 'muted';
      clearTimeout(noticeTimer);
      noticeTimer = null;
      if (wasPending) renderSoon();
    }
  }

  function armPendingExit() {
    pendingExit = true;
    clearTimeout(pendingExitTimer);
    setNotice(EXIT_HINT, 'error');
    pendingExitTimer = setTimeout(() => {
      pendingExit = false;
      pendingExitTimer = null;
    }, 2000);
    pendingExitTimer.unref?.();
  }

  function handleCtrlC() {
    // Prefer copy when a free-range selection is active (Grok-style).
    if (hasChatSelection()) {
      void copyChatSelection();
      return;
    }
    if (hasSelection()) {
      void copyInputSelection();
      return;
    }
    if (state.busy && abortHandler) {
      abortHandler();
      clearPendingExit({ clearNotice: true });
      setNotice('Stopping generation…', 'warning');
      return;
    }
    if (pendingExit) {
      terminate();
      return;
    }
    armPendingExit();
  }

  function mount(notice) {
    if (mounted) return;
    mounted = true;
    wasRaw = !!process.stdin.isRaw;
    wasFlowing = process.stdin.readableFlowing;
    try {
      if (notice) setNotice(notice, 'success');
      invalidatePaintCache();
      // 1000/1002/1006: press + drag + SGR mouse (input + scrollback character select).
      // Do NOT enable 1003 (any-motion) — hover events would force constant full repaints.
      process.stdout.write('\x1b[3J\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h');
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', onData);
      process.stdout.on('resize', onResize);
      process.once('exit', onExit);
      process.once('SIGTERM', onSigterm);
      spinnerTimer = setInterval(() => {
        if (!state.busy) return;
        state.frame = (state.frame + 1) % SPINNER.length;
        // Dirty-line paint only rewrites the status row when nothing else changed.
        renderNow();
      }, 120);
      spinnerTimer.unref?.();
      renderNow();
    } catch (error) {
      destroy();
      throw error;
    }
  }

  function onResize() {
    invalidatePaintCache();
    renderNow();
  }

  function destroy() {
    if (!mounted) return;
    mounted = false;
    clearTimeout(renderTimer);
    clearTimeout(noticeTimer);
    clearTimeout(transientTimer);
    clearTimeout(escapeTimer);
    clearTimeout(pendingExitTimer);
    clearInterval(spinnerTimer);
    pendingExit = false;
    pendingExitTimer = null;
    process.stdin.removeListener('data', onData);
    process.stdout.removeListener('resize', onResize);
    process.removeListener('exit', onExit);
    process.removeListener('SIGTERM', onSigterm);
    process.stdin.setRawMode?.(wasRaw);
    if (wasFlowing !== true) process.stdin.pause();
    cleanupTerminal();
  }

  function readInput() {
    state.busy = false;
    state.pendingQueue = [];
    state.scroll = 0;
    renderNow();
    return new Promise((resolve) => {
      inputResolve = resolve;
    });
  }

  function submitInput() {
    if (commandSuggestions().length) completeCommand();
    const value = state.input.trim();
    if (value) state.followups = [];

    // While the agent is working: queue follow-ups, or empty Enter injects mid-run (steering).
    if (state.busy) {
      if (!value) {
        const ok = busySubmitHandler?.({ text: '', mode: 'promote' });
        if (ok) {
          state.pendingQueue = [];
          setNotice('Injecting mid-run…', 'success');
        } else {
          setNotice('Nothing queued to inject. Type a follow-up first.', 'muted');
        }
        renderNow();
        return;
      }
      if (value.startsWith('/')) {
        setNotice('Commands are unavailable while working.', 'warning');
        return;
      }
      const ok = busySubmitHandler?.({ text: value, mode: 'queue' });
      if (!ok) {
        setNotice('Could not queue message.', 'warning');
        return;
      }
      state.input = '';
      state.cursor = 0;
      state.inputScroll = 0;
      clearSelection();
      if (state.history.at(-1) !== value) state.history.push(value);
      state.historyIndex = state.history.length;
      state.historyDraft = '';
      if (!state.pendingQueue.includes(value)) state.pendingQueue.push(value);
      setNotice(`Queued (${state.pendingQueue.length}) · empty Enter injects mid-run`, 'muted');
      renderNow();
      return;
    }

    if (!value || !inputResolve) return;
    state.input = '';
    state.cursor = 0;
    state.inputScroll = 0;
    clearSelection();
    if (state.history.at(-1) !== value) state.history.push(value);
    state.historyIndex = state.history.length;
    state.historyDraft = '';
    state.busy = true;
    state.pendingQueue = [];
    const resolve = inputResolve;
    inputResolve = null;
    renderNow();
    resolve(value);
  }

  function submitAction(value) {
    if (!inputResolve || state.busy) return false;
    const resolve = inputResolve;
    inputResolve = null;
    state.busy = true;
    state.pendingQueue = [];
    renderNow();
    resolve(value);
    return true;
  }

  function openCommandPalette() {
    if (state.busy || state.overlay) return;
    void pick({
      title: 'Commands',
      subtitle: 'Run a workspace action',
      options: state.commands
        .filter(([command]) => !['/quit', '/q', '/clear'].includes(command))
        .map(([command, description]) => ({ label: command, hint: description, action: command })),
      searchable: true,
    }).then((command) => {
      if (command) submitAction(command);
    });
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
        handleMouse(Number(mouse[1]), mouse[4], Number(mouse[2]), Number(mouse[3]));
        continue;
      }
      // Incomplete SGR mouse — wait (do not treat `<…` as a partial CSI key).
      if (isPartialMouseSequence(inputBuffer)) {
        scheduleEscapeFlush();
        return;
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

      // Batch consecutive printable graphemes (Korean jamo / syllables often arrive together).
      // One insert + one paint keeps the composer in sync without one-keystroke lag.
      if (!state.overlay && state.focus === 'prompt') {
        const batched = takePrintableRun(inputBuffer);
        if (batched) {
          inputBuffer = inputBuffer.slice(batched.bytes);
          if (pendingExit) clearPendingExit({ clearNotice: true });
          insertText(batched.text);
          continue;
        }
      }

      const char = iterateGraphemes(inputBuffer)[0] || inputBuffer[0];
      if (!char) return;
      inputBuffer = inputBuffer.slice(char.length);
      handleKey(char);
    }
  }

  /**
   * Pull a run of printable (non-escape) graphemes from the front of the buffer.
   * Stops before ESC so CSI/mouse sequences are not swallowed.
   */
  function takePrintableRun(buffer) {
    if (!buffer || buffer.startsWith('\x1b')) return null;
    let text = '';
    let bytes = 0;
    for (const grapheme of iterateGraphemes(buffer)) {
      if (grapheme.startsWith('\x1b')) break;
      if (grapheme === '\r' || grapheme === '\n' || grapheme === '\t') break;
      if (grapheme < ' ' || grapheme === '\u007f') break;
      text += grapheme;
      bytes += grapheme.length;
      // Bound a single batch so huge pastes without bracketed-paste still paint progressively.
      if (bytes >= 400) break;
    }
    if (!text) return null;
    return { text, bytes };
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
    // Shift+arrows extend selection (must run before normalizeKey collapses modifiers).
    const shiftArrow = key.match(/^\x1b\[(?:1;|)\s*2([A-D])$/) || key.match(/^\x1b\[1;2([A-D])$/);
    if (shiftArrow && !state.overlay && state.focus === 'prompt') {
      const dir = shiftArrow[1];
      if (dir === 'D') return moveCursor(-1, { extend: true });
      if (dir === 'C') return moveCursor(1, { extend: true });
      if (dir === 'A') {
        if (state.selectAnchor == null) state.selectAnchor = state.cursor;
        if (moveInputVisualLine(-1)) return;
        return;
      }
      if (dir === 'B') {
        if (state.selectAnchor == null) state.selectAnchor = state.cursor;
        if (moveInputVisualLine(1)) return;
        return;
      }
    }

    key = normalizeKey(key);
    if (state.overlay) {
      handleOverlayKey(key);
      return;
    }

    if (key === '\u0003') {
      handleCtrlC();
      return;
    }
    if (pendingExit) clearPendingExit({ clearNotice: true });

    // Tab completes a slash command when the suggestion list is open.
    // Otherwise it toggles Grok-style prompt ↔ scrollback focus.
    if (key === '\t') {
      if (state.focus === 'prompt' && completeCommand()) return;
      if (state.focus === 'prompt') focusScrollback();
      else focusPrompt();
      return;
    }

    // ——— Scrollback focus (navigate / copy blocks like Grok) ———
    if (state.focus === 'scrollback') {
      if (key === ' ' || key === '\x1b[Z') {
        focusPrompt();
        return;
      }
      if (key === 'y' || key === 'Y') {
        void copyScrollback();
        return;
      }
      if (key === '\x1b[A' || key === 'k') {
        selectEntryByDelta(-1);
        return;
      }
      if (key === '\x1b[B' || key === 'j') {
        selectEntryByDelta(1);
        return;
      }
      if (key === '\x1b[5~') return scrollBy(viewportHeight() - 2);
      if (key === '\x1b[6~') return scrollBy(-(viewportHeight() - 2));
      if (key === '\r' || key === '\n' || key === '\x1b[C' || key === 'l') {
        toggleSelectedEntry();
        return;
      }
      if (key === '\x1b[D' || key === 'h') {
        collapseSelectedEntry();
        return;
      }
      if (key === '\x1b') {
        if (hasChatSelection()) {
          clearChatSelection();
          renderSoon();
          return;
        }
        focusPrompt();
        return;
      }
      // Grok simple mode: typing a letter jumps back to the prompt and inserts it.
      if (key.length === 1 && key >= ' ' && key !== 'y' && key !== 'Y' && key !== 'j' && key !== 'k' && key !== 'h' && key !== 'l') {
        focusPrompt();
        insertText(key);
        return;
      }
      return;
    }

    if (key === '\x1b') {
      if (state.busy && abortHandler) {
        abortHandler();
        setNotice('Stopping generation…', 'warning');
        return;
      }
      if (hasSelection()) {
        clearSelection();
        renderSoon();
        return;
      }
      if (state.input) {
        state.input = '';
        state.cursor = 0;
        state.inputScroll = 0;
        clearSelection();
      } else {
        state.scroll = 0;
      }
      renderSoon();
      return;
    }
    if (key === '\x1b[5~') return scrollBy(viewportHeight() - 2);
    if (key === '\x1b[6~') return scrollBy(-(viewportHeight() - 2));
    if (key === '\x1b[A') {
      clearSelection();
      // Multi-line input: move caret to the visual line above (scroll follows caret).
      if (moveInputVisualLine(-1)) return;
      return moveCommand(-1) || scrollBy(3);
    }
    if (key === '\x1b[B') {
      clearSelection();
      if (moveInputVisualLine(1)) return;
      return moveCommand(1) || scrollBy(-3);
    }
    // Ctrl+D toggles the most recent edit/write diff.
    if (key === '\u0004') return toggleLastDiffTool();
    // Ctrl+A selects all input (Home is still \x1b[H).
    if (key === '\u0001') return selectAllInput();

    // While working, still allow composing/queueing the next prompt.
    if (state.busy) {
      if (key === '\x1b[D') return moveCursor(-1);
      if (key === '\x1b[C') return moveCursor(1);
      if (key === '\x1b[H') return setCursor(0);
      if (key === '\x1b[F' || key === '\u0005') return setCursor(inputChars().length);
      if (key === '\x1b[3~') return deleteForward();
      if (key === '\u007f' || key === '\b') return deleteBackward();
      if (key === '\u0015') {
        state.input = '';
        state.cursor = 0;
        state.inputScroll = 0;
        clearSelection();
        renderNow();
        return;
      }
      if (key === '\r' || key === '\n') {
        submitInput();
        return;
      }
      if (key >= ' ') insertText(key);
      return;
    }
    if (key === '\u000b') return openCommandPalette();
    if (key === '\u001a') return submitAction('/undo');
    if (key === '\u0019') return submitAction('/redo');
    if (key === '\u0010') return moveHistory(-1);
    if (key === '\u000e') return moveHistory(1);
    if (key === '\x1b[D') return moveCursor(-1);
    if (key === '\x1b[C') return moveCursor(1);
    if (key === '\x1b[H') return setCursor(0);
    if (key === '\x1b[F' || key === '\u0005') return setCursor(inputChars().length);
    if (key === '\x1b[3~') return deleteForward();
    if (key === '\u007f' || key === '\b') return deleteBackward();
    if (key === '\u0015') {
      state.input = '';
      state.cursor = 0;
      state.inputScroll = 0;
      clearSelection();
      renderNow();
      return;
    }
    if (key === '\r' || key === '\n') {
      submitInput();
      return;
    }
    if (!state.input && !state.busy && state.followups.length && /^[1-3]$/.test(key)) {
      const item = state.followups[Number(key) - 1];
      if (item?.text) {
        state.input = item.text;
        state.cursor = iterateGraphemes(item.text).length;
        submitInput();
      }
      return;
    }
    if (key >= ' ') insertText(key);
  }

  function handleOverlayKey(key) {
    const overlay = state.overlay;
    if (key === '\u0003') {
      handleCtrlC();
      return;
    }
    if (pendingExit) clearPendingExit({ clearNotice: true });
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
    // Hotkeys only when not filtering — e.g. `k` deletes, but typing `/search` can use k.
    if (overlay.hotkeys && Object.prototype.hasOwnProperty.call(overlay.hotkeys, key) && !(overlay.searchable && overlay.query)) {
      const options = filteredOptions(overlay);
      const selected = options[overlay.index];
      if (selected) {
        closeOverlay(selected, { hotkey: overlay.hotkeys[key] });
        return;
      }
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

  function handleMouse(button, action, col = 1, row = 1) {
    if (state.overlay) return;
    const btn = Number(button) || 0;
    const isRelease = action === 'm';
    const isPress = action === 'M';

    // SGR: 64 = wheel up, 65 = wheel down.
    if (isPress && (btn === 64 || btn === 65 || (btn & 64) !== 0)) {
      inputDragging = false;
      chatDragging = false;
      const down = btn === 65 || (btn & 1) === 1;
      if (isComposerInputRow(row)) {
        if (scrollInputBy(down ? 1 : -1)) return;
      }
      const amount = Math.max(3, Math.floor(viewportHeight() / 4));
      scrollBy(down ? -amount : amount);
      return;
    }

    // Left button: 0 = press/release, 32 = drag motion while held.
    const leftHeld = btn === 0 || btn === 32;
    if (!leftHeld) return;

    if (isPress && btn === 0 && isComposerInputRow(row)) {
      chatDragging = false;
      clearChatSelection();
      focusPrompt();
      const offset = offsetFromMouse(col, row);
      if (offset == null) return;
      inputDragging = true;
      state.selectAnchor = offset;
      state.cursor = offset;
      syncInputViewport();
      renderSoon();
      return;
    }

    if (isPress && btn === 0 && isChatRow(row)) {
      // Drag for character-range select; click (no drag) keeps block select.
      inputDragging = false;
      clearSelection();
      state.focus = 'scrollback';
      const pos = bodyPosFromMouse(col, row);
      if (!pos) return;
      chatDragging = true;
      state.chatSelAnchor = pos;
      state.chatSelEnd = pos;
      // Mouse select must not auto-scroll — only highlight the entry under the click.
      selectEntryAtScreenRow(row);
      return;
    }

    if (chatDragging && btn === 32) {
      const pos = bodyPosFromMouse(col, row);
      if (!pos) return;
      state.chatSelEnd = pos;
      // Track which block the drag is over (never auto-scroll mid-drag).
      selectEntryAtBodyLine(pos.line, { ensureVisible: false });
      renderSoon();
      return;
    }

    if (inputDragging && isPress && btn === 32) {
      const offset = offsetFromMouse(col, row);
      if (offset == null) return;
      state.cursor = offset;
      // Keep anchor; selection is [anchor, cursor].
      syncInputViewport();
      renderSoon();
      return;
    }

    if (chatDragging && isRelease) {
      chatDragging = false;
      if (!hasChatSelection()) clearChatSelection();
      renderSoon();
      return;
    }

    if (inputDragging && isRelease) {
      inputDragging = false;
      if (state.selectAnchor === state.cursor) state.selectAnchor = null;
      renderSoon();
    }
  }

  function isChatRow(screenRow) {
    const hit = state.chatHit;
    if (!hit) return false;
    const row = Number(screenRow) || 0;
    return row >= hit.first && row <= hit.last;
  }

  function focusPrompt() {
    state.focus = 'prompt';
    renderSoon();
  }

  function focusScrollback() {
    state.focus = 'scrollback';
    if (state.selectedEntry < 0 || !state.entries[state.selectedEntry]) {
      selectEntryByDelta(-1);
    } else {
      ensureSelectedVisible();
      renderSoon();
    }
  }

  function selectableEntryIndexes() {
    return state.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => ['user', 'assistant', 'tool', 'notice', 'banner', 'thinking', 'info', 'todo'].includes(entry.type))
      .map(({ index }) => index);
  }

  function selectEntryByDelta(delta) {
    clearChatSelection();
    const list = selectableEntryIndexes();
    if (!list.length) {
      state.selectedEntry = -1;
      renderSoon();
      return;
    }
    let pos = list.indexOf(state.selectedEntry);
    if (pos < 0) pos = delta > 0 ? -1 : list.length;
    pos = Math.max(0, Math.min(list.length - 1, pos + delta));
    state.selectedEntry = list[pos];
    ensureSelectedVisible();
    renderSoon();
  }

  function selectEntryAtScreenRow(screenRow) {
    const meta = state.viewportMeta;
    if (!meta || !state.entryRanges?.length) return;
    const bodyLine = meta.bodyStart + (Number(screenRow) - meta.chatFirst);
    // Click/drag only — keep scroll put. Keyboard nav still uses ensureSelectedVisible.
    selectEntryAtBodyLine(bodyLine, { ensureVisible: false });
  }

  function selectEntryAtBodyLine(bodyLine, { ensureVisible = false } = {}) {
    const range = state.entryRanges?.find((item) => bodyLine >= item.start && bodyLine < item.end);
    if (!range) return;
    if (state.selectedEntry === range.index && !ensureVisible) {
      renderSoon();
      return;
    }
    state.selectedEntry = range.index;
    if (ensureVisible) ensureSelectedVisible();
    renderSoon();
  }

  /** Map absolute mouse cell → body line index + display-cell column. */
  function bodyPosFromMouse(col, row) {
    const meta = state.viewportMeta;
    const hit = state.chatHit;
    if (!meta || !hit) return null;
    const r = Math.max(hit.first, Math.min(hit.last, Number(row) || 0));
    const bodyLength = Math.max(0, Number(meta.bodyLength) || 0);
    if (bodyLength <= 0) return { line: 0, col: 0 };
    const rawLine = meta.bodyStart + (r - meta.chatFirst);
    const line = Math.max(0, Math.min(bodyLength - 1, rawLine));
    const contentLeft = Number(meta.contentLeft) || 1;
    let cell = Math.max(0, (Number(col) || 1) - contentLeft);
    const cached = state.bodyCache?.[line];
    if (cached != null) {
      // Allow the exclusive end boundary at the line's full width.
      cell = Math.max(0, Math.min(displayWidth(cached), cell));
    }
    return { line, col: cell };
  }

  function hasChatSelection() {
    return !!chatSelectionRange();
  }

  function chatSelectionRange() {
    const a = state.chatSelAnchor;
    const b = state.chatSelEnd;
    if (!a || !b) return null;
    if (a.line === b.line && a.col === b.col) return null;
    if (a.line < b.line || (a.line === b.line && a.col <= b.col)) {
      return { start: a, end: b };
    }
    return { start: b, end: a };
  }

  function clearChatSelection() {
    state.chatSelAnchor = null;
    state.chatSelEnd = null;
  }

  function paintChatSelection(body) {
    const range = chatSelectionRange();
    if (!range || !body?.length) return;
    const { start, end } = range;
    for (let line = start.line; line <= end.line; line += 1) {
      if (line < 0 || line >= body.length) continue;
      const lineStart = line === start.line ? start.col : 0;
      const lineEnd = line === end.line ? end.col : Number.POSITIVE_INFINITY;
      if (!(lineEnd > lineStart)) continue;
      body[line] = paintInverseCells(body[line] || '', lineStart, lineEnd);
    }
  }

  function extractChatSelectionText() {
    const range = chatSelectionRange();
    const body = state.bodyCache;
    if (!range || !body?.length) return '';
    const { start, end } = range;
    const parts = [];
    for (let line = start.line; line <= end.line; line += 1) {
      if (line < 0 || line >= body.length) continue;
      const plain = stripAnsi(body[line] || '');
      const lineStart = line === start.line ? start.col : 0;
      const lineEnd = line === end.line ? end.col : Number.POSITIVE_INFINITY;
      parts.push(sliceByCells(plain, lineStart, lineEnd));
    }
    return parts.join('\n');
  }

  async function copyChatSelection() {
    const text = extractChatSelectionText().replace(/\s+$/u, '');
    if (!text) {
      setNotice('Selection is empty.', 'muted');
      return;
    }
    const ok = await copyText(text);
    // Clear so a second Ctrl+C can still arm quit (double-Ctrl+C exit).
    clearChatSelection();
    renderSoon();
    setNotice(ok ? 'Copied selection.' : 'Copy failed.', ok ? 'success' : 'error');
  }

  async function copyInputSelection() {
    const range = selectionRange();
    if (!range) return;
    const text = inputChars().slice(range.start, range.end).join('');
    if (!text) {
      setNotice('Selection is empty.', 'muted');
      return;
    }
    const ok = await copyText(text);
    clearSelection();
    renderSoon();
    setNotice(ok ? 'Copied selection.' : 'Copy failed.', ok ? 'success' : 'error');
  }

  async function copyScrollback() {
    if (hasChatSelection()) {
      await copyChatSelection();
      return;
    }
    await copySelectedEntry();
  }

  function ensureSelectedVisible() {
    const range = state.entryRanges?.find((item) => item.index === state.selectedEntry);
    const meta = state.viewportMeta;
    if (!range || !meta) return;
    const { bodyLength, viewHeight } = meta;
    const maxScroll = Math.max(0, bodyLength - viewHeight);
    // Visible body window: [start, start+viewHeight) where start = bodyLength - viewHeight - scroll
    let start = Math.max(0, bodyLength - viewHeight - state.scroll);
    if (range.start < start) {
      state.scroll = Math.max(0, Math.min(maxScroll, bodyLength - viewHeight - range.start));
    } else if (range.end > start + viewHeight) {
      state.scroll = Math.max(0, Math.min(maxScroll, bodyLength - range.end));
    }
  }

  function entryCopyText(entry) {
    if (!entry) return '';
    if (entry.type === 'user' || entry.type === 'assistant' || entry.type === 'notice' || entry.type === 'banner') {
      return String(entry.text || '');
    }
    if (entry.type === 'thinking') return String(entry.text || `thinking${entry.turn ? ` turn ${entry.turn}` : ''}`);
    if (entry.type === 'tool') {
      const lines = [`${entry.name || 'tool'}${entry.detail ? `  ${entry.detail}` : ''}`];
      if (entry.result?.diff?.lines?.length) {
        for (const line of entry.result.diff.lines) {
          const mark = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
          lines.push(`${mark} ${line.text || ''}`);
        }
      } else if (entry.result) {
        const preview = resultDetail(entry.result);
        if (preview) lines.push(preview);
      }
      return lines.join('\n');
    }
    if (entry.type === 'info') {
      const rows = (entry.rows || []).map((row) => (Array.isArray(row) ? row.join(': ') : String(row)));
      return [entry.title, ...rows].filter(Boolean).join('\n');
    }
    if (entry.type === 'todo') {
      return (entry.todos || []).map((todo) => `- [${todo.status}] ${todo.content || todo.id}`).join('\n');
    }
    return '';
  }

  async function copySelectedEntry() {
    const entry = state.entries[state.selectedEntry];
    if (!entry) {
      setNotice('Nothing selected to copy.', 'muted');
      return;
    }
    const text = entryCopyText(entry).trim();
    if (!text) {
      setNotice('Selected block has no text.', 'muted');
      return;
    }
    const ok = await copyText(text);
    setNotice(ok ? 'Copied block.' : 'Copy failed.', ok ? 'success' : 'error');
  }

  function toggleSelectedEntry() {
    const entry = state.entries[state.selectedEntry];
    if (!entry) return;
    if (entry.type === 'tool' && entry.result?.diff) {
      entry.expanded = entry.expanded === false;
      renderSoon();
    }
  }

  function collapseSelectedEntry() {
    const entry = state.entries[state.selectedEntry];
    if (entry?.type === 'tool' && entry.result?.diff) {
      entry.expanded = false;
      renderSoon();
    }
  }

  function isComposerInputRow(screenRow) {
    const hit = state.composerInputHit;
    if (!hit) return false;
    const row = Number(screenRow) || 0;
    return row >= hit.first && row <= hit.last;
  }

  /** Map absolute mouse cell to grapheme offset in state.input. */
  function offsetFromMouse(col, row) {
    const hit = state.composerInputHit;
    if (!hit || !isComposerInputRow(row)) return null;
    const layout = inputVisualLayout();
    if (!layout.length) return 0;
    const lineIndex = (Number(row) - hit.first) + state.inputScroll;
    if (lineIndex < 0) return 0;
    if (lineIndex >= layout.length) return inputChars().length;
    const line = layout[lineIndex];
    const targetCells = Math.max(0, (Number(col) || 1) - hit.contentLeft);
    const chars = inputChars().slice(line.start, line.end);
    let cells = 0;
    let offset = line.start;
    for (const ch of chars) {
      const w = displayWidth(ch);
      if (cells + w > targetCells) {
        // Click on left half of glyph → before; right half → after.
        if (targetCells - cells < w / 2) return offset;
        return offset + 1;
      }
      cells += w;
      offset += 1;
    }
    return line.end;
  }

  function hasSelection() {
    return state.selectAnchor != null && state.selectAnchor !== state.cursor;
  }

  function selectionRange() {
    if (!hasSelection()) return null;
    return {
      start: Math.min(state.selectAnchor, state.cursor),
      end: Math.max(state.selectAnchor, state.cursor),
    };
  }

  function clearSelection() {
    state.selectAnchor = null;
  }

  /** Delete the current selection if any. Returns true when something was removed. */
  function deleteSelection() {
    const range = selectionRange();
    if (!range) return false;
    const chars = inputChars();
    chars.splice(range.start, range.end - range.start);
    state.input = chars.join('');
    state.cursor = range.start;
    state.selectAnchor = null;
    state.commandIndex = 0;
    return true;
  }

  function selectAllInput() {
    const len = inputChars().length;
    if (!len) {
      clearSelection();
      return;
    }
    state.selectAnchor = 0;
    state.cursor = len;
    syncInputViewport();
    renderNow();
  }

  function paintInputRow(row) {
    const text = row.text || '';
    const range = selectionRange();
    if (!range) return text;
    const selStart = Math.max(range.start, row.start);
    const selEnd = Math.min(range.end, row.end);
    if (selStart >= selEnd) return text;
    const chars = iterateGraphemes(text);
    const a = selStart - row.start;
    const b = selEnd - row.start;
    return `${chars.slice(0, a).join('')}${t.inverse(chars.slice(a, b).join(''))}${chars.slice(b).join('')}`;
  }

  function contentWidthNow() {
    return Math.max(18, (process.stdout.columns || 80) - 4);
  }

  function composerBodyWidth(width = contentWidthNow()) {
    return Math.max(8, width - 4);
  }

  /**
   * Soft-wrap layout matching the composer body width.
   * Offsets are grapheme indices (same unit as state.cursor).
   */
  function inputVisualLayout(width = contentWidthNow()) {
    const max = composerBodyWidth(width);
    const text = state.input || '';
    const rows = [];
    let offset = 0;
    const parts = text.split('\n');
    for (let pi = 0; pi < parts.length; pi++) {
      const graphemes = iterateGraphemes(parts[pi]);
      if (!graphemes.length) {
        rows.push({ start: offset, end: offset, text: '' });
      } else {
        let i = 0;
        while (i < graphemes.length) {
          let cells = 0;
          const start = offset + i;
          let line = '';
          while (i < graphemes.length) {
            const ch = graphemes[i];
            const w = displayWidth(ch);
            if (cells > 0 && cells + w > max) break;
            line += ch;
            cells += w;
            i += 1;
          }
          if (i === start - offset && graphemes[i]) {
            // Pathologically wide glyph — still advance one unit.
            line = graphemes[i];
            i += 1;
          }
          rows.push({ start, end: offset + i, text: line });
        }
      }
      offset += graphemes.length;
      if (pi < parts.length - 1) offset += 1; // account for '\n'
    }
    if (!rows.length) rows.push({ start: 0, end: 0, text: '' });
    return rows;
  }

  function locateCursorInLayout(rows, cursor) {
    const maxCursor = inputChars().length;
    const pos = Math.max(0, Math.min(maxCursor, cursor));
    const all = inputChars();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const next = rows[i + 1];
      if (pos < row.start || pos > row.end) continue;
      // Soft-wrap boundary: pos === row.end === next.start → keep caret on this line's end.
      if (pos === row.end && next && next.start === row.end && i < rows.length - 1) {
        const prefix = all.slice(row.start, pos).join('');
        return { row: i, col: pos - row.start, cells: displayWidth(prefix) };
      }
      if (pos >= row.start && pos <= row.end) {
        const prefix = all.slice(row.start, pos).join('');
        return { row: i, col: pos - row.start, cells: displayWidth(prefix) };
      }
    }
    const last = rows[rows.length - 1];
    const prefix = all.slice(last.start, last.end).join('');
    return { row: rows.length - 1, col: last.end - last.start, cells: displayWidth(prefix) };
  }

  function inputContentLineCount(width = contentWidthNow()) {
    return inputVisualLayout(width).length;
  }

  function inputCursorLine(width = contentWidthNow()) {
    return locateCursorInLayout(inputVisualLayout(width), state.cursor).row;
  }

  function visibleComposerLines(total) {
    // Always reserve COMPOSER_MIN_LINES so typing the first character does not
    // shrink the box (that jump made the caret look like a flashing bar).
    return Math.min(COMPOSER_MAX_LINES, Math.max(COMPOSER_MIN_LINES, total || 1));
  }

  function clampInputScroll(width = contentWidthNow()) {
    const total = inputContentLineCount(width);
    const visible = visibleComposerLines(total);
    const maxScroll = Math.max(0, total - visible);
    const cursorLine = inputCursorLine(width);
    if (cursorLine < state.inputScroll) state.inputScroll = cursorLine;
    if (cursorLine >= state.inputScroll + visible) state.inputScroll = cursorLine - visible + 1;
    state.inputScroll = Math.max(0, Math.min(maxScroll, state.inputScroll));
    return { total, visible, maxScroll };
  }

  /** Move caret up/down by one visual (wrapped) line. Returns false if already at edge. */
  function moveInputVisualLine(delta) {
    if (!state.input) return false;
    const rows = inputVisualLayout();
    if (rows.length <= 1) return false;
    const loc = locateCursorInLayout(rows, state.cursor);
    const target = loc.row + delta;
    if (target < 0 || target >= rows.length) return false;

    const dest = rows[target];
    const destChars = inputChars().slice(dest.start, dest.end);
    let cells = 0;
    let cursor = dest.start;
    for (const ch of destChars) {
      const w = displayWidth(ch);
      if (cells + w > loc.cells) break;
      cells += w;
      cursor += 1;
    }
    // If the previous line caret was past this line's width, land on end-of-line.
    if (loc.cells >= displayWidth(destChars.join(''))) cursor = dest.end;

    state.cursor = cursor;
    // Keep selection anchor when extending via Shift+↑/↓ (caller sets anchor first).
    syncInputViewport();
    renderNow();
    return true;
  }

  function scrollInputBy(delta) {
    // Prefer moving the caret with the view — pure viewport scroll was immediately
    // undone by clampInputScroll() keeping the caret in view (looked like a no-op).
    clearSelection();
    return moveInputVisualLine(delta);
  }

  function syncInputViewport() {
    clampInputScroll();
  }

  function toggleLastDiffTool() {
    const entry = [...state.entries].reverse().find((item) => item.type === 'tool' && item.result?.diff);
    if (!entry) {
      setNotice('No edit diff to toggle.', 'muted');
      return;
    }
    entry.expanded = entry.expanded === false;
    renderNow();
  }

  function insertText(value) {
    deleteSelection();
    const chars = inputChars();
    const incoming = iterateGraphemes(String(value ?? ''));
    if (!incoming.length) return;
    chars.splice(state.cursor, 0, ...incoming);
    state.input = chars.join('');
    state.cursor += incoming.length;
    state.commandIndex = 0;
    clearSelection();
    syncInputViewport();
    // Immediate paint so each Korean jamo/syllable appears on the keystroke that produced it.
    renderNow();
  }

  function moveCursor(amount, { extend = false } = {}) {
    setCursor(state.cursor + amount, { extend });
  }

  function setCursor(value, { extend = false } = {}) {
    if (extend) {
      if (state.selectAnchor == null) state.selectAnchor = state.cursor;
    } else {
      clearSelection();
    }
    state.cursor = Math.max(0, Math.min(inputChars().length, value));
    syncInputViewport();
    renderNow();
  }

  function deleteBackward() {
    if (deleteSelection()) {
      syncInputViewport();
      renderNow();
      return;
    }
    if (!state.cursor) return;
    const chars = inputChars();
    chars.splice(state.cursor - 1, 1);
    state.input = chars.join('');
    state.cursor -= 1;
    state.commandIndex = 0;
    clearSelection();
    syncInputViewport();
    renderNow();
  }

  function deleteForward() {
    if (deleteSelection()) {
      syncInputViewport();
      renderNow();
      return;
    }
    const chars = inputChars();
    if (state.cursor >= chars.length) return;
    chars.splice(state.cursor, 1);
    state.input = chars.join('');
    state.commandIndex = 0;
    clearSelection();
    syncInputViewport();
    renderNow();
  }

  function commandSuggestions() {
    if (!/^\/[^\s]*$/.test(state.input)) return [];
    const query = state.input.slice(1).toLowerCase();
    return state.commands.filter(([command]) => command.slice(1).startsWith(query));
  }

  function visibleCommandSuggestions() {
    const suggestions = commandSuggestions();
    const limit = 5;
    if (suggestions.length <= limit) {
      return suggestions.map((suggestion, index) => ({ suggestion, index }));
    }
    const start = Math.max(0, Math.min(state.commandIndex - limit + 1, suggestions.length - limit));
    return suggestions.slice(start, start + limit).map((suggestion, offset) => ({
      suggestion,
      index: start + offset,
    }));
  }

  function moveCommand(amount) {
    const suggestions = commandSuggestions();
    if (!suggestions.length) return false;
    state.commandIndex = (state.commandIndex + amount + suggestions.length) % suggestions.length;
    renderSoon();
    return true;
  }

  function completeCommand() {
    const suggestions = commandSuggestions();
    if (!suggestions.length) return false;
    const [command] = suggestions[Math.min(state.commandIndex, suggestions.length - 1)];
    state.input = command;
    state.cursor = iterateGraphemes(command).length;
    state.commandIndex = 0;
    renderNow();
    return true;
  }

  function moveHistory(amount) {
    if (!state.history.length) return;
    if (state.historyIndex === state.history.length) state.historyDraft = state.input;
    state.historyIndex = Math.max(0, Math.min(state.history.length, state.historyIndex + amount));
    state.input = state.historyIndex === state.history.length
      ? state.historyDraft
      : state.history[state.historyIndex];
    state.cursor = inputChars().length;
    state.commandIndex = 0;
    renderNow();
  }

  function stopThinking() {
    if (state.activeThinking) state.activeThinking.active = false;
    state.activeThinking = null;
  }

  function scrollBy(amount) {
    state.scroll = Math.max(0, state.scroll + amount);
    renderNow();
  }

  function pick({ title, subtitle, options, initialIndex = 0, searchable = false, signal = null, footer = null, hotkeys = null } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        resolve(value);
      };
      const overlay = {
        type: 'picker',
        title,
        subtitle,
        options: options.map((option) => ({ ...option, label: sanitizeTerminalText(option.label), hint: sanitizeTerminalText(option.hint || '') })),
        index: Math.max(0, initialIndex),
        query: '',
        searchable,
        footer: footer || null,
        hotkeys: hotkeys && typeof hotkeys === 'object' ? hotkeys : null,
        resolve: finish,
      };
      const abort = () => {
        if (state.overlay !== overlay) return;
        state.overlay = null;
        renderNow();
        finish(null);
      };
      state.overlay = overlay;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      renderNow();
    });
  }

  async function requestPermission(toolName, detail, { signal = null } = {}) {
    const label = toolLabel(toolName);
    const choice = await pick({
      title: `Permission · ${label}`,
      subtitle: sanitizeTerminalText(detail),
      signal,
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
      signal,
    });
    return confirm === 'always' ? 'always' : false;
  }

  async function askQuestion(prompt, options, { signal = null } = {}) {
    const choice = await pick({
      title: 'Question',
      subtitle: sanitizeTerminalText(prompt),
      signal,
      options: options.map((option) => ({
        label: option.label,
        hint: option.id,
        action: option.id,
      })),
    });
    if (choice == null) return null;
    return options.find((option) => option.id === choice) || { id: choice, label: String(choice) };
  }

  function closeOverlay(option, meta = null) {
    const overlay = state.overlay;
    state.overlay = null;
    renderNow();
    if (!option) {
      overlay.resolve(overlay.type === 'permission' ? false : null);
      return;
    }
    if (meta?.hotkey) {
      overlay.resolve({
        hotkey: meta.hotkey,
        option,
        action: option.action ?? option,
      });
      return;
    }
    overlay.resolve(option.action ?? option);
  }

  function filteredOptions(overlay) {
    if (!overlay.searchable || !overlay.query) return overlay.options;
    const query = overlay.query.toLowerCase();
    return overlay.options.filter((option) => `${option.label} ${option.hint}`.toLowerCase().includes(query));
  }

  function writeUser(text) {
    clearTransientEntries(false);
    state.entries.push({ type: 'user', text: String(text) });
    state.contextEstimate += Math.ceil(String(text).length / 4) + 12;
    state.scroll = 0;
    markBusy('model');
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
    addTransientEntry({ type: 'notice', text: String(text), tone });
  }

  function addBanner(text, tone = 'muted', { transient = false } = {}) {
    const entry = { type: 'banner', text: String(text || ''), tone };
    if (transient) {
      addTransientEntry(entry);
      return;
    }
    state.entries.push(entry);
    state.scroll = 0;
    renderSoon();
  }

  function showInfo(title, rows) {
    addTransientEntry({ type: 'info', title, rows });
  }

  function addTransientEntry(entry) {
    state.entries.push({
      ...entry,
      transient: true,
      expiresAt: Date.now() + TRANSIENT_ENTRY_TTL_MS,
    });
    state.scroll = 0;
    scheduleTransientCleanup();
    renderSoon();
  }

  function clearTransientEntries(render = true) {
    const entries = state.entries.filter((entry) => !entry.transient);
    if (entries.length === state.entries.length) return false;
    state.entries = entries;
    state.scroll = 0;
    clearTimeout(transientTimer);
    transientTimer = null;
    if (render) renderSoon();
    return true;
  }

  function scheduleTransientCleanup() {
    clearTimeout(transientTimer);
    const nextExpiry = state.entries
      .filter((entry) => entry.transient)
      .reduce((earliest, entry) => Math.min(earliest, entry.expiresAt), Infinity);
    if (!Number.isFinite(nextExpiry)) return;
    transientTimer = setTimeout(() => {
      const now = Date.now();
      state.entries = state.entries.filter((entry) => !entry.transient || entry.expiresAt > now);
      state.scroll = 0;
      scheduleTransientCleanup();
      renderSoon();
    }, Math.max(0, nextExpiry - Date.now()));
    transientTimer.unref?.();
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

  function markBusy(activity = '') {
    if (!state.busy) state.busyStartedAt = Date.now();
    state.busy = true;
    if (activity) state.busyActivity = activity;
  }

  function setBusy(value) {
    if (value) markBusy(state.busyActivity || 'model');
    else {
      state.busy = false;
      state.busyStartedAt = 0;
      state.busyActivity = '';
      state.pendingQueue = [];
    }
    renderSoon();
  }

  function setPendingQueue(items) {
    state.pendingQueue = Array.isArray(items) ? items.map((item) => String(item)) : [];
    renderSoon();
  }

  function setBusySubmitHandler(handler) {
    busySubmitHandler = typeof handler === 'function' ? handler : null;
  }

  function resetSession(sessionId, title = '', notice = '', messages = []) {
    clearTimeout(transientTimer);
    transientTimer = null;
    state.sessionId = sessionId;
    state.sessionTitle = title;
    state.entries = hydrateMessages(messages);
    state.usage = null;
    state.contextEstimate = estimateMessagesTokens(messages);
    state.scroll = 0;
    state.input = '';
    state.cursor = 0;
    state.inputScroll = 0;
    state.selectAnchor = null;
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
        markBusy('model');
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
        markBusy('model');
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
      onAssistantRetry() {
        // Drop incomplete streamed text so a provider replay does not double-print.
        stopThinking();
        const index = [...state.entries].map((entry, i) => ({ entry, i }))
          .reverse()
          .find(({ entry }) => entry.type === 'assistant' && !entry.completedAt)?.i;
        if (index != null) state.entries.splice(index, 1);
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
        markBusy(toolLabel(name));
        stopThinking();
        state.entries.push({ type: 'tool', name, detail, status: 'running', result: null, expanded: true });
        renderSoon();
      },
      onToolEnd(name, detail, status, result) {
        let entry = [...state.entries].reverse().find((item) => item.type === 'tool' && item.status === 'running');
        const hasDiff = !!(result?.diff?.lines?.length || result?.diff?.additions || result?.diff?.deletions);
        if (!entry) {
          entry = { type: 'tool', name, detail, status, result, expanded: hasDiff };
          state.entries.push(entry);
        } else {
          Object.assign(entry, {
            name,
            detail,
            status,
            result,
            expanded: entry.expanded !== false && (hasDiff || entry.expanded),
          });
        }
        // File edits open expanded by default (OpenCode accordion default-open for edit).
        if (hasDiff && entry.expanded !== false) entry.expanded = true;
        renderSoon();
      },
      onTodo(todos) {
        state.entries.push({ type: 'todo', todos });
        renderSoon();
      },
      onSubagent({ id, title, status, detail, result }) {
        let entry = [...state.entries].reverse().find((item) => item.type === 'subagent' && item.id === id);
        if (!entry) {
          entry = { type: 'subagent', id, title, status, detail, result: null };
          state.entries.push(entry);
        } else {
          Object.assign(entry, { title, status, detail, result: result || entry.result });
        }
        renderSoon();
      },
      askQuestion,
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
    // Coalesce any pending debounced paint into this write.
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    const width = Math.max(1, process.stdout.columns || 80);
    const height = Math.max(1, process.stdout.rows || 24);
    const frame = renderFrame(width, height);
    const lines = frame.split('\n');
    // Force exact terminal geometry so CUP updates never scroll the alt screen.
    while (lines.length < height) lines.push('');
    if (lines.length > height) lines.length = height;
    const cursor = cursorPosition(width, height);

    const sizeChanged = lastPaintedWidth !== width || lastPaintedHeight !== height || !lastPaintedLines;
    const prev = sizeChanged ? null : lastPaintedLines;

    // Dirty-line paint: only rewrite rows that changed. Full home+frame+\x1b[J redraws
    // caused vertical shake on Windows Terminal (especially with mouse/IME/spinner).
    // DEC 2026 batches the update where supported.
    let dirty = sizeChanged;
    if (!sizeChanged) {
      for (let i = 0; i < height; i++) {
        if (prev[i] !== lines[i]) {
          dirty = true;
          break;
        }
      }
    }

    let out = '';
    if (dirty) {
      // Synchronized update prevents intermediate frames. Avoid cursor hide on
      // partial paints — hide/show thrash breaks Windows Korean IME preedit and
      // looks like vertical shake when combined with full-frame rewrites.
      out += '\x1b[?2026h';
      if (sizeChanged) {
        out += '\x1b[?25l\x1b[H';
        for (let i = 0; i < height; i++) {
          out += `${lines[i]}\x1b[K`;
          if (i < height - 1) out += '\r\n';
        }
      } else {
        for (let i = 0; i < height; i++) {
          if (prev[i] === lines[i]) continue;
          // Absolute row positioning avoids LF column-mode quirks that scroll the buffer.
          out += `\x1b[${i + 1};1H${lines[i]}\x1b[K`;
        }
      }
      if (cursor) out += `\x1b[${cursor.row};${cursor.column}H\x1b[?25h`;
      else out += '\x1b[?25l';
      out += '\x1b[?2026l';
    } else if (cursor) {
      // Composer text unchanged (caret-only move): reposition without a full paint.
      out += `\x1b[${cursor.row};${cursor.column}H\x1b[?25h`;
    } else {
      out += '\x1b[?25l';
    }
    process.stdout.write(out);

    lastPaintedLines = lines;
    lastPaintedWidth = width;
    lastPaintedHeight = height;
    syncTabTitle();
  }

  function cursorPosition(width, height) {
    // Hide caret in scrollback focus (Grok-style block navigation).
    if (state.focus === 'scrollback') return null;
    // Keep the caret visible while working so follow-ups can be typed into the queue.
    if (state.overlay || width < 20 || height < 12) return null;
    const geom = state.composerGeom;
    if (!geom) return null;
    const layout = inputVisualLayout(geom.contentWidth);
    if (!layout.length && !state.input) {
      return {
        row: Math.min(height, geom.inputRow0 + 1),
        column: Math.max(1, Math.min(width - 1, geom.contentLeft)),
      };
    }
    const loc = locateCursorInLayout(layout, state.cursor);
    const row = layout[loc.row] || layout[0] || { start: 0, end: 0 };
    const linePrefix = inputChars().slice(row.start, state.cursor).join('');
    const lineInWindow = Math.max(0, loc.row - state.inputScroll);
    const inputRow0 = geom.composerTop + geom.prefixLines + 1 + lineInWindow;
    return {
      row: Math.min(height, inputRow0 + 1),
      column: Math.max(1, Math.min(width - 1, geom.contentLeft + displayWidth(linePrefix))),
    };
  }

  function renderFrame(width, height) {
    if (width < 20 || height < 12) {
      state.composerInputHit = null;
      state.chatHit = null;
      state.bodyCache = null;
      state.composerGeom = null;
      return renderTinyFrame(width, height);
    }
    const screen = Array.from({ length: height }, () => '');
    const contentWidth = Math.max(18, width - 4);
    const left = Math.max(0, Math.floor((width - contentWidth) / 2));

    renderHeader(screen, width, contentWidth, left);
    const composer = renderComposer(contentWidth);
    const meta = composer._composerMeta || { inputBodyLines: 2, prefixLines: 0 };
    const composerTop = Math.max(5, height - composer.length);
    const viewTop = 3;
    const viewHeight = Math.max(1, composerTop - viewTop - 1);
    const body = state.entries.length ? renderEntries(contentWidth) : renderWelcome(contentWidth, viewHeight);
    // Snapshot pre-paint body for plain-text copy (no inverse paint).
    state.bodyCache = body.slice();
    paintChatSelection(body);
    const maxScroll = Math.max(0, body.length - viewHeight);
    state.scroll = Math.min(state.scroll, maxScroll);
    const start = Math.max(0, body.length - viewHeight - state.scroll);
    const visible = body.slice(start, start + viewHeight);
    for (let i = 0; i < visible.length; i++) screen[viewTop + i] = offsetLine(visible[i], left);
    for (let i = 0; i < composer.length; i++) screen[composerTop + i] = offsetLine(composer[i], left);
    // Mouse rows/cols are 1-based. Input body starts one row below the top border.
    // Text starts after: left padding + '│' + ' '.
    const firstInput0 = composerTop + meta.prefixLines + 1;
    const contentLeft = left + 3;
    state.composerInputHit = {
      first: firstInput0 + 1,
      last: firstInput0 + Math.max(1, meta.inputBodyLines),
      contentLeft,
      bodyWidth: composerBodyWidth(contentWidth),
    };
    // Geometry for cursor placement — must match this painted frame (no second renderComposer).
    state.composerGeom = {
      composerTop,
      prefixLines: meta.prefixLines,
      inputBodyLines: meta.inputBodyLines,
      contentWidth,
      contentLeft,
      inputRow0: firstInput0,
      left,
    };
    state.chatHit = {
      first: viewTop + 1,
      last: Math.max(viewTop + 1, composerTop),
    };
    state.viewportMeta = {
      bodyLength: body.length,
      viewHeight,
      bodyStart: start,
      chatFirst: viewTop + 1,
      // 1-based screen column of the first content cell in the chat body.
      contentLeft: left + 1,
    };
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
    const focusTag = state.focus === 'scrollback' ? t.dim('[scrollback]') : t.dim('[prompt]');
    const leftText = `${t.bold(t.accent('◆ cheapai'))} ${t.dim('/')} ${t.white(clipCells(project, Math.max(8, Math.floor(contentWidth * 0.28))))} ${focusTag}`;
    const elapsed = state.busy && state.busyStartedAt ? formatElapsed(Date.now() - state.busyStartedAt) : '';
    const activity = state.busyActivity ? ` ${state.busyActivity}` : '';
    const busy = state.busy
      ? `${t.yellow(SPINNER[state.frame])} ${t.dim(`working${activity}${elapsed ? ` ${elapsed}` : ''}`)}`
      : t.green('● ready');
    const workspaceMode = state.goalMode ? t.magenta('goal · plan only') : permissionLabel(state.mode);
    const rightText = `${t.cyan(clipCells(clean(state.model), Math.max(8, Math.floor(contentWidth * 0.3))))}  ${workspaceMode}`;
    screen[0] = offsetLine(joinSides(leftText, rightText, contentWidth), left);
    const subtitle = clean(state.sessionTitle || (state.sessionId ? `session ${state.sessionId.slice(0, 8)}` : 'new chat'));
    const details = [busy];
    if (state.effort && state.effort !== 'off') details.push(t.dim(`effort ${state.effort}`));
    if (state.agent && state.agent !== 'build') details.push(t.magenta(`agent ${state.agent}`));
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
    const hitZones = [];
    const entryRanges = [];
    for (let entryIndex = 0; entryIndex < state.entries.length; entryIndex += 1) {
      const entry = state.entries[entryIndex];
      const start = lines.length;
      if (entry.type === 'user') renderUser(lines, entry, width);
      else if (entry.type === 'assistant') renderAssistant(lines, entry, width);
      else if (entry.type === 'thinking' && state.showThinking) renderThinking(lines, entry, width);
      else if (entry.type === 'tool') renderTool(lines, entry, width);
      else if (entry.type === 'notice') renderNotice(lines, entry, width);
      else if (entry.type === 'banner') renderBanner(lines, entry, width);
      else if (entry.type === 'info') renderInfo(lines, entry, width);
      else if (entry.type === 'todo') renderTodo(lines, entry, width);
      else if (entry.type === 'subagent') renderSubagent(lines, entry, width);
      const end = lines.length;
      if (end > start) entryRanges.push({ index: entryIndex, start, end });
      if (entry.type === 'tool' && entry.result?.diff) {
        hitZones.push({ entryIndex, start, end });
      }
    }
    state.hitZones = hitZones;
    state.entryRanges = entryRanges;
    return lines;
  }

  function renderUser(lines, entry, width) {
    // Role chrome lives on its own line so multi-line drag-select of the body
    // does not pick up chrome on every wrapped line.
    lines.push('');
    lines.push(t.dim(t.user('you')));
    const body = safeWrap(entry.text, width);
    for (const line of body) lines.push(t.user(line));
  }

  function renderAssistant(lines, entry, width) {
    lines.push('');
    const raw = entry.text || (state.busy ? '…' : '');
    const cleaned = stripAnsi(String(raw)).replace(/\r/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ' ');
    // Full-width body — no ✦/indent prefix on content lines (clean drag-select).
    const body = wrapAnsi(formatMarkdown(cleaned), Math.max(1, width));
    if (!body.length) body.push(state.busy ? '…' : '');
    for (const line of body) lines.push(t.agent(line));
    if (entry.completedAt || entry.usage) {
      const elapsed = entry.completedAt && entry.startedAt ? ` · ${((entry.completedAt - entry.startedAt) / 1000).toFixed(1)}s` : '';
      const usage = entry.usage ? ` · ${formatTokens(entry.usage.prompt_tokens || 0)} in / ${formatTokens(entry.usage.completion_tokens || 0)} out` : '';
      const costValue = entry.usage?.cost_credits ?? entry.usage?.cost_krw;
      const cost = Number(costValue) > 0 ? ` · ₩${formatCompactCredits(costValue)}` : '';
      lines.push(t.dim(`${state.model}${elapsed}${usage}${cost}`));
    }
  }

  function renderThinking(lines, entry, width) {
    if (entry.active && state.busy) {
      const dot = state.frame < SPINNER.length / 2 ? t.yellow('●') : t.dim('○');
      lines.push('', t.dim(`${dot} thinking${entry.turn ? ` · turn ${entry.turn}` : ''}`));
    } else {
      lines.push('', t.dim(`thinking${entry.turn ? ` · turn ${entry.turn}` : ''}`));
    }
    if (state.showToolDetails && entry.text) {
      for (const line of safeWrap(entry.text, width).slice(-8)) lines.push(t.dim(line));
    }
  }

  function renderTool(lines, entry, width) {
    const mark = entry.status === 'running' ? t.yellow('●') : entry.status === 'ok' ? t.green('✓') : t.red('✗');
    const label = t.tool(toolLabel(entry.name));
    const summary = toolSummary(entry);
    const diff = entry.result?.diff;
    const expandable = !!(diff?.lines?.length || diff?.additions || diff?.deletions);
    const expanded = expandable && entry.expanded !== false;
    const chevron = expandable ? (expanded ? t.dim('▾') : t.dim('▸')) : '';
    let statsText = '';
    if (diff && (diff.additions || diff.deletions)) {
      const bits = [];
      if (diff.additions) bits.push(t.green(`+${diff.additions}`));
      if (diff.deletions) bits.push(t.red(`-${diff.deletions}`));
      statsText = `  ${bits.join(' ')}`;
    }
    // Single summary line only — no tree gutter on every wrapped/diff line.
    lines.push(
      `${mark} ${label}${
        summary ? `  ${t.dim(clipCells(summary, Math.max(8, width - 24)))}` : ''
      }${statsText}${chevron ? `  ${chevron}` : ''}`,
    );
    if (expanded && diff?.lines?.length) {
      const painted = paintDiffLines(diff.lines, {
        paintAdd: (s) => t.green(s),
        paintDel: (s) => t.red(s),
        paintCtx: (s) => t.dim(s),
        maxWidth: Math.max(12, width),
        maxLines: state.showToolDetails ? 80 : 36,
      });
      for (const row of painted) lines.push(row);
      if (diff.truncated) lines.push(t.dim('… diff truncated'));
    } else if (state.showToolDetails || entry.status === 'error' || entry.status === 'denied') {
      const detail = [entry.detail, resultDetail(entry.result)].filter(Boolean).join(' · ');
      for (const line of safeWrap(detail, width).slice(0, 10)) {
        lines.push(entry.status === 'error' ? t.red(line) : t.dim(line));
      }
    }
  }

  function renderNotice(lines, entry, width) {
    lines.push('');
    const paint = entry.tone === 'error' ? t.red : entry.tone === 'warning' ? t.yellow : entry.tone === 'success' ? t.green : t.dim;
    // No bullet prefix on each line — color alone signals tone for clean selection.
    for (const line of safeWrap(entry.text, width)) lines.push(paint(line));
  }

  function renderBanner(lines, entry, width) {
    lines.push('');
    const paint = entry.tone === 'error'
      ? t.red
      : entry.tone === 'warning'
        ? t.yellow
        : entry.tone === 'success'
          ? t.green
          : t.dim;
    lines.push(statusBanner(entry.text || '', width, paint));
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

  function renderSubagent(lines, entry, width) {
    const mark = entry.status === 'done' ? t.green('✓') : entry.status === 'error' || entry.status === 'aborted' ? t.red('✗') : t.yellow('●');
    lines.push('', `${mark} ${t.tool('Task')}  ${clipCells(clean(entry.title || 'subagent'), width - 10)}  ${t.dim(entry.status || '')}`);
    if (entry.detail && state.showToolDetails) {
      lines.push(t.dim(`  ${clipCells(clean(entry.detail), width - 4)}`));
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
    const bodyWidth = composerBodyWidth(width);
    const placeholder = state.busy
      ? (state.pendingQueue.length
        ? t.dim('Queue more… · empty Enter injects mid-run')
        : t.dim('Type a follow-up to queue…'))
      : t.dim('Ask anything…');
    // Do not inject a phantom cursor character — it changes wrap points and desyncs
    // ↑/↓ visual-line motion from what is painted. The real terminal caret is used.
    const layout = inputVisualLayout(width);
    const lineCount = Math.max(1, state.input ? layout.length : 1);
    const vis = visibleComposerLines(lineCount);
    const maxScr = Math.max(0, lineCount - vis);
    const cursorLine = locateCursorInLayout(layout, state.cursor).row;
    if (cursorLine < state.inputScroll) state.inputScroll = cursorLine;
    if (cursorLine >= state.inputScroll + vis) state.inputScroll = cursorLine - vis + 1;
    state.inputScroll = Math.max(0, Math.min(maxScr, state.inputScroll));

    const border = state.busy ? t.yellow : t.accent;
    const out = renderCommandSuggestions(width);
    if (state.pendingQueue.length) {
      const preview = state.pendingQueue.slice(-3);
      const hidden = state.pendingQueue.length - preview.length;
      if (hidden > 0) out.push(t.dim(`  … ${hidden} more queued`));
      for (const item of preview) {
        out.push(t.yellow(`  ▸ queue  ${clipCells(clean(item), Math.max(8, width - 12))}`));
      }
    }
    if (state.followups.length && !state.busy && !state.input) {
      state.followups.slice(0, 3).forEach((item, index) => {
        out.push(t.dim(`  ${index + 1}  ${clipCells(clean(item.text), Math.max(8, width - 6))}`));
      });
    }
    const prefixLines = out.length;
    if (maxScr > 0) {
      const label = ` ${state.inputScroll + 1}-${Math.min(lineCount, state.inputScroll + vis)}/${lineCount} `;
      const dash = Math.max(0, width - 2 - displayWidth(label));
      out.push(`${border('╭')}${border('─'.repeat(dash))}${t.dim(label)}${border('╮')}`);
    } else {
      out.push(border(`╭${'─'.repeat(width - 2)}╮`));
    }
    for (let i = 0; i < vis; i++) {
      const row = state.input ? layout[state.inputScroll + i] : null;
      const line = state.input
        ? (row ? paintInputRow(row) : '')
        : (i === 0 ? placeholder : '');
      out.push(`${border('│')} ${line}${' '.repeat(Math.max(0, bodyWidth - displayWidth(line)))} ${border('│')}`);
    }
    out.push(border(`╰${'─'.repeat(width - 2)}╯`));
    const mode = state.goalMode
      ? t.magenta('goal · plan only')
      : state.mode === 'yolo'
        ? t.yellow('all tools')
        : state.mode === 'accept-edits'
          ? t.cyan('edits allowed')
          : t.dim('ask for writes');
    const leftMeta = state.busy && state.pendingQueue.length
      ? `${t.yellow(`${state.pendingQueue.length} queued`)}  ${t.dim(state.model)}`
      : `${t.accent('build')}  ${t.dim(state.model)}`;
    out.push(joinSides(leftMeta, mode, width));
    const notice = state.notice
      ? paintNotice(state.notice, state.noticeTone)
      : commandSuggestions().length
        ? t.dim('↑↓ select  ·  Tab complete  ·  Enter run  ·  Esc clear')
        : state.followups.length && !state.input && !state.busy
          ? t.dim('1/2/3 follow-up  ·  Enter send  ·  Esc clear')
        : state.focus === 'scrollback'
          ? t.dim('drag select  ·  ↑↓ block  ·  y/Ctrl+C copy  ·  Tab prompt')
          : state.busy
            ? t.dim('Enter queue  ·  empty Enter inject  ·  drag select chat  ·  Esc stop')
            : t.dim('Enter send  ·  drag select chat/input  ·  Tab scrollback  ·  Esc stop');
    out.push(clipStyled(notice, width));
    out._composerMeta = { inputBodyLines: vis, prefixLines };
    return out;
  }

  function inputWithCursor() {
    const chars = inputChars();
    const before = chars.slice(0, state.cursor).join('');
    const current = chars[state.cursor] || ' ';
    const after = chars.slice(state.cursor + (chars[state.cursor] ? 1 : 0)).join('');
    return `${before}${current}${after}`;
  }

  function renderCommandSuggestions(width) {
    const suggestions = visibleCommandSuggestions();
    if (!suggestions.length) return [];
    const allSuggestions = commandSuggestions();
    state.commandIndex = Math.min(state.commandIndex, allSuggestions.length - 1);
    return suggestions.map(({ suggestion: [command, description], index }) => {
      const marker = index === state.commandIndex ? t.accent('▌') : ' ';
      const label = index === state.commandIndex ? t.bold(command) : command;
      return clipStyled(`${marker} ${label}  ${t.dim(description)}`, width);
    });
  }

  function renderOverlay(screen, width, height, contentWidth) {
    const overlay = state.overlay;
    const options = filteredOptions(overlay);
    overlay.index = Math.max(0, Math.min(overlay.index, Math.max(0, options.length - 1)));
    const boxWidth = Math.max(16, contentWidth);
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
    rows.push('', t.dim(overlay.footer || '↑/↓ move  ·  Enter select  ·  Esc cancel'));

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
    askQuestion,
    writeUser,
    writeUsage,
    writeContext,
    addNotice,
    addBanner,
    showInfo,
    setBusy,
    setPendingQueue,
    setBusySubmitHandler,
    resetSession,
    renderSnapshot(columns = 80, rows = 24) {
      return renderFrame(Math.max(1, columns), Math.max(1, rows));
    },
    pressKey(key) {
      handleKey(key);
    },
    get input() {
      return state.input;
    },
    get focus() {
      return state.focus;
    },
    get commandIndex() {
      return state.commandIndex;
    },
    agentHooks,
    get model() { return state.model; },
    set model(value) { state.model = value; renderSoon(); },
    get mode() { return state.mode; },
    set mode(value) { state.mode = value; renderSoon(); },
    get effort() { return state.effort; },
    set effort(value) { state.effort = value; renderSoon(); },
    setAgent(value) { state.agent = value || 'build'; renderSoon(); },
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
    setFollowups(items) {
      state.followups = Array.isArray(items) ? items.slice(0, 3) : [];
      renderSoon();
    },
    setAbortHandler(handler) { abortHandler = typeof handler === 'function' ? handler : null; },
    setCommands(commands) {
      state.commands = [...COMMANDS, ...commands.map((command) => [`/${command.name}`, command.description])];
      renderSoon();
    },
  };
}

function safeWrap(value, width) {
  const text = stripAnsi(String(value || '')).replace(/\r/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ' ');
  return wrapAnsi(text, Math.max(1, width));
}

function readEscapeSequence(value) {
  if (!value.startsWith('\x1b') || value.length < 2) return null;
  // SGR mouse is handled separately; never treat it as a generic CSI key.
  if (value.startsWith('\x1b[<')) return null;
  if (value.startsWith('\x1b[')) return value.match(/^\x1b\[[0-?]*[ -/]*[@-~]/)?.[0] || null;
  if (value.startsWith('\x1bO')) return value.match(/^\x1bO[ -~]/)?.[0] || null;
  return '\x1b';
}

function readMouseSequence(value) {
  return value.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
}

/** True while an SGR mouse report is incomplete (wait for more stdin). */
function isPartialMouseSequence(value) {
  if (!value.startsWith('\x1b[<')) return false;
  return !/^\x1b\[<\d+;\d+;\d+[Mm]/.test(value);
}

function isPartialEscapeSequence(value) {
  if (value.startsWith('\x1b[<')) return false;
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

function clipCells(value, maxWidth) {
  const text = String(value || '');
  if (displayWidth(text) <= maxWidth) return text;
  let out = '';
  for (const char of iterateGraphemes(text)) {
    if (displayWidth(`${out}${char}…`) > maxWidth) break;
    out += char;
  }
  return `${out}…`;
}

function clipStyled(value, maxWidth) {
  const text = String(value || '');
  if (displayWidth(text) <= maxWidth) return text;
  return wrapAnsi(text, Math.max(1, maxWidth))[0] || '';
}

function paintNotice(value, tone) {
  if (tone === 'error') return t.red(value);
  if (tone === 'warning') return t.yellow(value);
  if (tone === 'success') return t.green(value);
  return t.dim(value);
}

function toolLabel(name) {
  return ({
    bash: 'Bash',
    read_file: 'Read',
    write_file: 'Write',
    edit_file: 'Edit',
    glob: 'Glob',
    grep: 'Grep',
    todo_write: 'Tasks',
    git: 'Git',
    web_fetch: 'Fetch',
    ask_question: 'Ask',
    task: 'Task',
    project_docs: 'Docs',
    skill: 'Skill',
    mcp_manage: 'MCP',
    list_mcp_tools: 'MCP',
    call_mcp_tool: 'MCP',
  })[name] || clean(name);
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
