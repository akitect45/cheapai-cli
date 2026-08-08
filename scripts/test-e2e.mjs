#!/usr/bin/env node
/**
 * E2E-ish checks for CheapAI CLI local agent pieces.
 * Usage:
 *   node scripts/test-e2e.mjs              # unit + tools only
 *   node scripts/test-e2e.mjs --live       # needs CHEAPAI_API_KEY or ~/.cheapai/auth.json
 *   node scripts/test-e2e.mjs --poll-shape # print device code + one poll
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
process.chdir(root);

let failed = 0;
function ok(name) {
  console.log(`  ✓ ${name}`);
}
function bad(name, err) {
  failed += 1;
  console.error(`  ✗ ${name}: ${err?.message || err}`);
}

console.log('cheapai e2e\n');

// 1) system prompt
{
  const { buildSystemPrompt } = await import('../src/prompts/system.js');
  const sp = buildSystemPrompt({ cwd: root, model: 'test-model' });
  if (sp.length < 800) bad('system prompt length', new Error('too short: ' + sp.length));
  else if (!sp.includes('edit_file') || !sp.includes('Hard rules')) bad('system prompt content', new Error('missing sections'));
  else ok(`system prompt (${sp.length} chars)`);

  const goalPrompt = buildSystemPrompt({ cwd: root, model: 'test-model', goalMode: true });
  if (!goalPrompt.includes('# Goal mode') || !goalPrompt.includes('/goal off')) {
    bad('goal system prompt', new Error('goal instructions missing'));
  } else ok('goal system prompt');
  const agentPrompt = buildSystemPrompt({ cwd: root, model: 'test-model', agentInstructions: 'Review security boundaries first.' });
  if (!agentPrompt.includes('# Agent profile') || !agentPrompt.includes('Review security boundaries first.')) {
    bad('agent profile prompt', new Error('agent instructions missing'));
  } else ok('agent profile prompt');
}

// 2) tools runtime
{
  const { createToolRuntime, TOOL_DEFINITIONS, shellInvocation } = await import('../src/agent/tools.js');
  if (TOOL_DEFINITIONS.length < 6) bad('tool defs', new Error('count ' + TOOL_DEFINITIONS.length));
  else ok(`tool definitions (${TOOL_DEFINITIONS.length})`);

  const windowsShell = shellInvocation('dir', 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
  const macShell = shellInvocation('pwd', 'darwin', { SHELL: '/bin/zsh' });
  if (windowsShell[0] !== 'C:\\Windows\\System32\\cmd.exe' || windowsShell[1][0] !== '/c' || macShell[0] !== 'bash' || macShell[1][0] !== '-lc') {
    bad('platform shell selection', new Error(JSON.stringify({ windowsShell, macShell })));
  } else ok('platform shell selection');

  const tmp = path.join(os.tmpdir(), `cheapai-e2e-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const rt = createToolRuntime({ cwd: tmp });

  const w = await rt.execute('write_file', {
    path: 'hello.txt',
    content: 'hello cheapai\nline2\n',
  });
  if (!w.ok) bad('write_file', w);
  else ok('write_file');

  const r = await rt.execute('read_file', { path: 'hello.txt' });
  if (!r.content || !String(r.content).includes('hello cheapai')) bad('read_file', r);
  else ok('read_file');

  const e = await rt.execute('edit_file', {
    path: 'hello.txt',
    old_string: 'hello cheapai',
    new_string: 'hello agent',
  });
  if (!e.ok) bad('edit_file', e);
  else ok('edit_file');

  const r2 = await rt.execute('read_file', { path: 'hello.txt' });
  if (!String(r2.content).includes('hello agent')) bad('edit verify', r2);
  else ok('edit verify');

  const g = await rt.execute('glob', { pattern: '*.txt' });
  if (!g.files?.length) bad('glob', g);
  else ok('glob');

  const gr = await rt.execute('grep', { pattern: 'agent', path: tmp });
  if (!gr.matches?.length) bad('grep', gr);
  else ok('grep');

  const b = await rt.execute('bash', { command: 'echo e2e-ok' });
  if (!b.ok || !String(b.stdout).includes('e2e-ok')) bad('bash', b);
  else ok('bash');

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// 3) poll normalizer
{
  const { browserInvocation, normalizePollResult, openBrowser, pollDeviceAuth, redactAuthSecrets } = await import('../src/auth.js');
  const cases = [
    [{ status: 'pending' }, 'pending', null],
    [{ status: 'approved', api_key: 'csk_abc' }, 'approved', 'csk_abc'],
    [{ status: 'success', apiKey: 'csk_x' }, 'approved', 'csk_x'],
    [{ ok: true, plainKey: 'csk_y' }, 'approved', 'csk_y'],
    [{ data: { api_key: 'csk_z' } }, 'approved', 'csk_z'],
    [{ status: 'completed', token: 'csk_t' }, 'approved', 'csk_t'],
  ];
  for (const [body, st, key] of cases) {
    const n = normalizePollResult(body, 200);
    if (n.status !== st || (key && n.api_key !== key)) {
      bad('normalize ' + JSON.stringify(body), new Error(JSON.stringify(n)));
    } else ok(`normalize ${st}${key ? ' +key' : ''}`);
  }
  if (normalizePollResult({}, 401).status !== 'error' || normalizePollResult({}, 500).status !== 'error' || normalizePollResult({}, 403).status !== 'pending') {
    bad('normalize HTTP statuses', new Error('unexpected HTTP status normalization'));
  } else ok('normalize HTTP statuses');

  const savedFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ status: 'pending' }), { status: 403 });
    const pending = await pollDeviceAuth({ webOrigin: 'https://example.invalid', deviceCode: 'test-device' });
    if (pending.status !== 'pending') bad('poll recognized HTTP state', new Error(JSON.stringify(pending)));
    else ok('poll recognized HTTP state');

    globalThis.fetch = async () => new Response('', { status: 500 });
    let rejected = false;
    try {
      await pollDeviceAuth({ webOrigin: 'https://example.invalid', deviceCode: 'test-device' });
    } catch {
      rejected = true;
    }
    if (!rejected) bad('poll HTTP failure', new Error('500 was accepted as pending'));
    else ok('poll HTTP failure');
  } finally {
    globalThis.fetch = savedFetch;
  }

  const safe = JSON.stringify(redactAuthSecrets({
    key: 'key_secret',
    api_key: 'csk_secret',
    accessToken: 'token_secret',
    nested: { deviceCode: 'device_secret' },
    status: 'approved',
  }));
  if (safe.includes('secret')) bad('credential redaction', new Error(safe));
  else ok('credential redaction');

  const macBrowser = browserInvocation('https://cheapai.im', 'darwin');
  const windowsBrowser = browserInvocation('https://cheapai.im', 'win32');
  if (macBrowser[0] !== 'open' || windowsBrowser[0] !== 'explorer.exe' || openBrowser('javascript:alert(1)') !== false) {
    bad('platform browser selection', new Error(JSON.stringify({ macBrowser, windowsBrowser })));
  } else ok('platform browser selection');
}

// 3b) authentication source safety
{
  const { resolveApiKey } = await import('../src/config.js');
  const envNames = ['CHEAPAI_API_KEY', 'CHEAPSUB_API_KEY', 'OPENAI_API_KEY'];
  const saved = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  try {
    envNames.forEach((name) => delete process.env[name]);
    process.env.OPENAI_API_KEY = 'openai-only-must-not-login-cheapai';
    if (resolveApiKey(null)) bad('CheapAI auth source', new Error('OPENAI_API_KEY was accepted'));
    else ok('OPENAI_API_KEY does not bypass auth welcome');
  } finally {
    for (const name of envNames) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

// 3c) usage, session accounting, and compaction
{
  const {
    contextUsageLabel,
    estimateMessagesTokens,
    formatCompactCredits,
    mergeSessionUsage,
  } = await import('../src/agent/usage.js');
  const { fetchAccountUsage } = await import('../src/llm/client.js');
  const savedFetch = globalThis.fetch;
  const savedHome = process.env.CHEAPAI_HOME;
  const tmpHome = path.join(os.tmpdir(), `cheapai-usage-${Date.now()}`);
  try {
    const merged = mergeSessionUsage({}, {
      prompt_tokens: 1200,
      completion_tokens: 300,
      cost_credits: 42.5,
      cost_usd: 0.0425,
    });
    if (merged.requests !== 1 || merged.totalTokens !== 1500 || merged.credits !== 42.5) {
      bad('session usage accounting', new Error(JSON.stringify(merged)));
    } else ok('session usage accounting');

    if (!contextUsageLabel(10_000, 20_000).includes('50%') || formatCompactCredits(12_345) !== '12.3k') {
      bad('usage formatting', new Error(contextUsageLabel(10_000, 20_000)));
    } else ok('usage formatting');

    globalThis.fetch = async (url, options) => {
      if (url !== 'https://api.example/v1/usage' || options.headers.Authorization !== 'Bearer csk_test') {
        throw new Error(`unexpected usage request: ${url}`);
      }
      return new Response(JSON.stringify({ object: 'cheapai.usage', balance: 9000, spentToday: 100 }), { status: 200 });
    };
    const remote = await fetchAccountUsage({ baseURL: 'https://api.example/v1', apiKey: 'csk_test' });
    if (remote.balance !== 9000 || remote.spentToday !== 100) bad('usage endpoint client', remote);
    else ok('usage endpoint client');

    process.env.CHEAPAI_HOME = tmpHome;
    fs.mkdirSync(tmpHome, { recursive: true });
    const { compactSession } = await import('../src/agent/compact.js');
    const session = {
      id: 'usage-test-session',
      cwd: tmpHome,
      model: 'test-model',
      title: 'Compaction test',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'first task ' + 'context '.repeat(550) },
        { role: 'assistant', content: 'first answer ' + 'implementation '.repeat(550) },
        { role: 'user', content: 'latest task' },
        { role: 'assistant', content: 'latest answer' },
      ],
    };
    const fakeClient = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [{ message: { content: 'Goal: preserve the latest task and continue the implementation.' } }],
              usage: { prompt_tokens: 50, completion_tokens: 20, cost_credits: 1 },
            };
          },
        },
      },
    };
    const compacted = await compactSession({ client: fakeClient, model: 'test-model', session });
    if (!compacted.compacted || session.messages.map((m) => m.role).join(',') !== 'system,user,assistant,user,assistant' || !session.compactions.length) {
      bad('session compaction', new Error(JSON.stringify({ compacted, roles: session.messages.map((m) => m.role) })));
    } else ok('session compaction');

    const unchanged = {
      id: 'usage-test-unchanged',
      cwd: tmpHome,
      model: 'test-model',
      title: 'No reduction test',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'older task ' + 'context '.repeat(550) },
        { role: 'assistant', content: 'older answer ' + 'implementation '.repeat(550) },
        { role: 'user', content: 'latest task' },
        { role: 'assistant', content: 'latest answer' },
      ],
    };
    const originalMessages = JSON.stringify(unchanged.messages);
    const expandingClient = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [{ message: { content: 'expanded summary '.repeat(2000) } }],
              usage: { prompt_tokens: 50, completion_tokens: 20 },
            };
          },
        },
      },
    };
    const notCompacted = await compactSession({ client: expandingClient, model: 'test-model', session: unchanged });
    if (notCompacted.compacted || JSON.stringify(unchanged.messages) !== originalMessages) {
      bad('non-reducing compaction', new Error('original session was replaced'));
    } else ok('non-reducing compaction');
  } catch (error) {
    bad('usage/compaction checks', error);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedHome === undefined) delete process.env.CHEAPAI_HOME;
    else process.env.CHEAPAI_HOME = savedHome;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// 4) terminal rendering primitives
{
  const { displayWidth, panel, statusBar, stripAnsi, wrapAnsi } = await import('../src/ui/draw.js');
  const wrapped = wrapAnsi('abcdefghij', 4);
  if (wrapped.join('') !== 'abcdefghij' || wrapped.some((line) => displayWidth(line) > 4)) {
    bad('terminal wrapping', new Error(JSON.stringify(wrapped)));
  } else ok('terminal wrapping');

  if (displayWidth('한글') !== 4) bad('terminal CJK width', new Error('unexpected width'));
  else ok('terminal CJK width');

  if (displayWidth('😀') !== 2) bad('terminal emoji width', new Error('unexpected width'));
  else ok('terminal emoji width');

  if (displayWidth('🇰🇷') !== 2 || displayWidth('👨‍👩‍👧‍👦') !== 2 || displayWidth('a\u200db') !== 2) {
    bad('terminal grapheme width', new Error('flag, ZWJ emoji, or text was over-counted'));
  } else ok('terminal grapheme width');

  const spaced = wrapAnsi('abcd ef', 4);
  if (spaced.join('') !== 'abcd ef' || spaced.some((line) => displayWidth(line) > 4)) {
    bad('terminal space wrapping', new Error(JSON.stringify(spaced)));
  } else ok('terminal space wrapping');

  const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  try {
    let overflow = null;
    for (const columns of [20, 40, 80]) {
      Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
      const blocks = [
        panel('connect with browser', ['https://cheapai.im/a/very/long/device/url']),
        statusBar({
          model: 'a-very-long-model-name-for-layout-testing',
          mode: 'accept-edits',
          effort: 'medium',
          cwd: path.join(root, 'a-very-long-workspace-name-for-layout-testing'),
          session: '12345678-1234-1234-1234-123456789abc',
        }),
      ];
      overflow = blocks
        .flatMap((block) => stripAnsi(block).split('\n'))
        .find((line) => displayWidth(line) > columns);
      if (overflow) break;
    }
    if (overflow) bad('responsive terminal layouts', new Error(overflow));
    else ok('responsive terminal layouts (20/40/80 cols)');
  } finally {
    if (columnsDescriptor) Object.defineProperty(process.stdout, 'columns', columnsDescriptor);
    else delete process.stdout.columns;
  }
}

// 4b) convenience commands and transcript export
{
  const { handleSlash } = await import('../src/ui/chat.js');
  const { exportSession } = await import('../src/agent/export.js');
  const notices = [];
  let showBalance = false;
  const ctx = {
    ui: { addNotice: (message, tone) => notices.push({ message, tone }) },
    get showBalance() { return showBalance; },
    set showBalance(value) { showBalance = !!value; },
    async refreshUsage() { return { balance: 12345.5 }; },
  };
  await handleSlash('/credit', ctx);
  await handleSlash('/credit on', ctx);
  if (!notices.some((item) => item.message.includes('₩12,345.5')) || !showBalance) {
    bad('credit slash command', new Error(JSON.stringify({ notices, showBalance })));
  } else ok('credit slash command');

  const tmp = path.join(os.tmpdir(), `cheapai-export-${Date.now()}`);
  try {
    fs.mkdirSync(tmp, { recursive: true });
    const destination = exportSession({
      id: 'export-session',
      cwd: tmp,
      model: 'test-model',
      title: 'Export test',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer' },
      ],
    }, 'transcript.md');
    const markdown = fs.readFileSync(destination, 'utf8');
    if (!markdown.includes('# Export test') || !markdown.includes('## User') || !markdown.includes('## Assistant')) {
      bad('session Markdown export', new Error(markdown));
    } else ok('session Markdown export');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// 4c) OpenCode-style session history, fork, import/export, and cancellation
{
  const savedHome = process.env.CHEAPAI_HOME;
  const tmp = path.join(os.tmpdir(), `cheapai-history-${Date.now()}`);
  process.env.CHEAPAI_HOME = path.join(tmp, '.cheapai');
  try {
    fs.mkdirSync(tmp, { recursive: true });
    fs.mkdirSync(path.join(tmp, '.opencode', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.opencode', 'commands', 'review.md'), '---\ndescription: Review the current diff\n---\nReview $ARGUMENTS, then report blockers.', 'utf8');
    fs.mkdirSync(path.join(tmp, '.cheapai', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.cheapai', 'agents', 'security.md'), '---\ndescription: Security reviewer\n---\nReview trust boundaries before edits.', 'utf8');
    const {
      beginTurn,
      finishTurn,
      recordFileChange,
      redoTurn,
      undoTurn,
    } = await import('../src/agent/history.js');
    const {
      exportSessionData,
      forkSession,
      importSessionData,
      sessionStats,
    } = await import('../src/agent/session.js');
    const { createToolRuntime } = await import('../src/agent/tools.js');
    const { loadCustomAgents, loadCustomCommands, renderCustomCommand } = await import('../src/agent/commands.js');

    const customCommands = loadCustomCommands(tmp);
    if (customCommands[0]?.name !== 'review' || renderCustomCommand(customCommands[0], 'the API') !== 'Review the API, then report blockers.') {
      bad('custom command templates', new Error(JSON.stringify(customCommands)));
    } else ok('custom command templates');
    const customAgents = loadCustomAgents(tmp);
    if (customAgents[0]?.name !== 'security' || !customAgents[0].instructions.includes('trust boundaries')) {
      bad('custom agent profiles', new Error(JSON.stringify(customAgents)));
    } else ok('custom agent profiles');

    const file = path.join(tmp, 'history.txt');
    fs.writeFileSync(file, 'before\n', 'utf8');
    const session = {
      id: 'history-session',
      cwd: tmp,
      model: 'test-model',
      title: 'History test',
      createdAt: new Date().toISOString(),
      messages: [{ role: 'system', content: 'system' }],
      usage: {},
    };
    const checkpoint = beginTurn(session);
    const runtime = createToolRuntime({
      cwd: tmp,
      onFileChange: (change) => recordFileChange(checkpoint, change),
    });
    session.messages.push({ role: 'user', content: 'edit the file' });
    await runtime.execute('edit_file', {
      path: file,
      old_string: 'before',
      new_string: 'after',
    });
    session.messages.push({ role: 'assistant', content: 'edited' });
    finishTurn(session, checkpoint);

    const undone = undoTurn(session);
    if (!undone.ok || fs.readFileSync(file, 'utf8') !== 'before\n' || session.messages.length !== 1) {
      bad('turn undo with file restore', new Error(JSON.stringify(undone)));
    } else ok('turn undo with file restore');

    const redone = redoTurn(session);
    if (!redone.ok || fs.readFileSync(file, 'utf8') !== 'after\n' || session.messages.at(-1)?.content !== 'edited') {
      bad('turn redo with file restore', new Error(JSON.stringify(redone)));
    } else ok('turn redo with file restore');

    const conflictCheckpoint = beginTurn(session);
    const conflictRuntime = createToolRuntime({
      cwd: tmp,
      onFileChange: (change) => recordFileChange(conflictCheckpoint, change),
    });
    session.messages.push({ role: 'user', content: 'edit again' });
    await conflictRuntime.execute('edit_file', {
      path: file,
      old_string: 'after',
      new_string: 'agent change',
    });
    session.messages.push({ role: 'assistant', content: 'edited again' });
    finishTurn(session, conflictCheckpoint);
    fs.writeFileSync(file, 'external change\n', 'utf8');
    const conflictUndo = undoTurn(session);
    if (!conflictUndo.ok || conflictUndo.filesSkipped !== 1 || fs.readFileSync(file, 'utf8') !== 'external change\n') {
      bad('undo conflict protection', new Error(JSON.stringify(conflictUndo)));
    } else ok('undo conflict protection');

    session.messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'edit_file', arguments: '{}' } }],
    });
    const fork = forkSession(session, { title: 'Forked history' });
    const exported = exportSessionData(fork, { sanitize: true });
    const imported = importSessionData(exported, { cwd: tmp });
    const stats = sessionStats([fork, imported]);
    if (fork.parentId !== session.id || imported.parentId !== fork.id || stats.sessions !== 2 || stats.tools.edit_file !== 2) {
      bad('session fork import export stats', new Error(JSON.stringify({ fork, imported, stats })));
    } else ok('session fork import export stats');

    const abortRuntime = createToolRuntime({ cwd: tmp });
    const controller = new AbortController();
    const running = abortRuntime.execute('bash', {
      command: 'node -e "setTimeout(() => {}, 5000)"',
      timeout_ms: 10_000,
    }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const aborted = await running;
    if (!aborted.aborted) bad('bash cancellation', new Error(JSON.stringify(aborted)));
    else ok('bash cancellation');
  } catch (error) {
    bad('session history checks', error);
  } finally {
    if (savedHome === undefined) delete process.env.CHEAPAI_HOME;
    else process.env.CHEAPAI_HOME = savedHome;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// 5) menu fallback safety
{
  const { resolveMenuAnswer } = await import('../src/ui/select.js');
  const options = [
    { label: 'Allow once', action: 'once', aliases: ['y', 'yes'] },
    { label: 'Reject', action: 'reject', aliases: ['n', 'no'] },
  ];
  if (resolveMenuAnswer(options, 'n')?.action !== 'reject' || resolveMenuAnswer(options, 'invalid') !== null) {
    bad('menu fallback safety', new Error('unsafe fallback selection'));
  } else ok('menu fallback safety');
}

// 6) permission policies
{
  const { createPermissionGate } = await import('../src/agent/permissions.js');
  const { toolsForMode } = await import('../src/agent/loop.js');
  const ask = createPermissionGate('ask');
  const edits = createPermissionGate('accept-edits');
  if (ask.requiresApproval('read_file') || !ask.requiresApproval('bash')) {
    bad('permission ask policy', new Error('unexpected approval policy'));
  } else ok('permission ask policy');
  if (edits.requiresApproval('edit_file') || !edits.requiresApproval('bash')) {
    bad('permission edit policy', new Error('unexpected approval policy'));
  } else ok('permission edit policy');

  const printGate = createPermissionGate('ask', null, { interactive: false });
  if (await printGate.approve('bash', 'echo should-not-prompt')) {
    bad('non-interactive permission', new Error('write prompt was allowed'));
  } else ok('non-interactive permission denial');

  const goalGate = createPermissionGate('ask', null, { interactive: false, allowTodo: true });
  const goalTools = toolsForMode(true).map((tool) => tool.function.name);
  if (!(await goalGate.approve('todo_write', 'plan')) || goalTools.includes('bash') || goalTools.includes('edit_file') || !goalTools.includes('read_file')) {
    bad('goal tool policy', new Error(JSON.stringify(goalTools)));
  } else ok('goal tool policy');
}

// 6b) Windows workspace matching
{
  const { comparableWorkspace } = await import('../src/agent/session.js');
  if (comparableWorkspace('C:/Users/Dev/Project', 'win32') !== comparableWorkspace('c:\\users\\dev\\project', 'win32')) {
    bad('Windows workspace matching', new Error('path casing differs'));
  } else ok('Windows workspace matching');
}

// 7) full-screen TUI frame
{
  const { displayWidth } = await import('../src/ui/draw.js');
  const { createFullscreenChatUi } = await import('../src/ui/fullscreen.js');
  const ui = createFullscreenChatUi({
    model: 'claude-sonnet-5',
    mode: 'ask',
    effort: 'off',
    cwd: root,
    sessionId: '12345678-1234-1234-1234-123456789abc',
    sessionUsage: { lastInputTokens: 4000 },
    contextWindow: 10000,
    contextTokens: 4000,
    accountUsage: { balance: 12345 },
  });
  for (const [columns, rows] of [[10, 8], [40, 16], [80, 24], [120, 36]]) {
    const frame = ui.renderSnapshot(columns, rows);
    const lines = frame.split('\n');
    if (lines.length !== rows || lines.some((line) => displayWidth(line) > columns)) {
      bad(`fullscreen frame ${columns}x${rows}`, new Error('frame dimensions exceeded'));
    } else if (columns >= 20 && (!frame.includes('Ask anything') || !frame.includes('ready'))) {
      bad(`fullscreen frame ${columns}x${rows}`, new Error('missing composer or status'));
    } else ok(`fullscreen frame ${columns}x${rows}`);
  }
  const defaultUsageFrame = ui.renderSnapshot(120, 36);
  if (defaultUsageFrame.includes('₩12.3k') || !defaultUsageFrame.includes('ctx 40%')) {
    bad('usage status frame default', new Error('balance should be hidden while context remains visible'));
  } else ok('usage status frame default');
  ui.setShowBalance(true);
  const visibleUsageFrame = ui.renderSnapshot(120, 36);
  if (!visibleUsageFrame.includes('₩12.3k')) {
    bad('usage status frame enabled', new Error('enabled balance missing'));
  } else ok('usage status frame enabled');

  ui.resetSession('87654321', 'Resumed work', '', [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'Previous question' },
    { role: 'assistant', content: 'Previous answer' },
  ]);
  const resumed = ui.renderSnapshot(80, 24);
  if (!resumed.includes('Previous question') || !resumed.includes('Previous answer')) {
    bad('fullscreen session hydration', new Error('resumed messages missing'));
  } else ok('fullscreen session hydration');

  const slashUi = createFullscreenChatUi({
    model: 'claude-sonnet-5',
    mode: 'ask',
    effort: 'off',
    cwd: root,
    sessionId: '12345678',
    input: '/',
  });
  const slashFrame = slashUi.renderSnapshot(80, 24);
  if (!slashFrame.includes('/help') || !slashFrame.includes('/status')) {
    bad('slash command suggestions', new Error('dropdown suggestions missing'));
  } else ok('slash command suggestions');

  const extensionUi = createFullscreenChatUi({
    model: 'claude-sonnet-5',
    mode: 'ask',
    effort: 'off',
    agent: 'security',
    commands: [{ name: 'review', description: 'Review the current diff' }],
    cwd: root,
    sessionId: '12345678',
    input: '/rev',
  });
  const extensionFrame = extensionUi.renderSnapshot(100, 28);
  if (!extensionFrame.includes('/review') || !extensionFrame.includes('agent security')) {
    bad('agent and custom command frame', new Error('agent label or custom command missing'));
  } else ok('agent and custom command frame');

  const koreanUi = createFullscreenChatUi({
    model: 'claude-sonnet-5',
    mode: 'ask',
    effort: 'off',
    cwd: root,
    sessionId: '12345678',
    input: '한글 입력.',
  });
  const koreanFrame = koreanUi.renderSnapshot(80, 24);
  if (!koreanFrame.includes('한글 입력.') || koreanFrame.split('\n').some((line) => displayWidth(line) >= 80)) {
    bad('Korean input frame', new Error('wide input frame overflowed'));
  } else ok('Korean input frame');

  const thinkingUi = createFullscreenChatUi({
    model: 'claude-sonnet-5',
    mode: 'ask',
    effort: 'off',
    cwd: root,
    sessionId: '12345678',
  });
  thinkingUi.writeUser('thinking test');
  thinkingUi.agentHooks().onThinking(1);
  const thinkingFrame = thinkingUi.renderSnapshot(80, 24);
  if (!thinkingFrame.includes('Thinking · turn 1') || !thinkingFrame.includes('●')) {
    bad('thinking indicator', new Error('blinking indicator missing'));
  } else ok('thinking indicator');

  const goalUi = createFullscreenChatUi({
    model: 'claude-sonnet-5',
    mode: 'ask',
    effort: 'off',
    goalMode: true,
    cwd: root,
    sessionId: '12345678',
    input: '/g',
  });
  const goalFrame = goalUi.renderSnapshot(80, 24);
  if (!goalFrame.includes('goal · plan only') || !goalFrame.includes('/goal')) {
    bad('goal mode frame', new Error('goal state or command missing'));
  } else ok('goal mode frame');

  const scrollUi = createFullscreenChatUi({
    model: 'claude-sonnet-5',
    mode: 'ask',
    effort: 'off',
    cwd: root,
    sessionId: '12345678',
    messages: Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `message ${index}` })),
  });
  const scrollFrame = scrollUi.renderSnapshot(80, 24);
  if (!scrollFrame.includes('┃') || !scrollFrame.includes('│')) {
    bad('conversation scrollbar', new Error('scrollbar missing'));
  } else ok('conversation scrollbar');
}

// 8) device endpoints shape
if (process.argv.includes('--poll-shape') || process.argv.includes('--live')) {
  try {
    const { startDeviceAuth, pollDeviceAuth, redactAuthSecrets } = await import('../src/auth.js');
    const d = await startDeviceAuth();
    ok(`device/code user_code=${d.user_code}`);
    const p = await pollDeviceAuth({ deviceCode: d.device_code });
    ok(`device/poll status=${p.status}`);
    console.log('  raw poll:', JSON.stringify(redactAuthSecrets(p.raw || p)).slice(0, 300));
  } catch (e) {
    bad('device endpoints', e);
  }
}

// 9) live LLM + tools (optional)
if (process.argv.includes('--live')) {
  try {
    const { createClient, chatWithTools } = await import('../src/llm/client.js');
    const { TOOL_DEFINITIONS, createToolRuntime } = await import('../src/agent/tools.js');
    const { buildSystemPrompt } = await import('../src/prompts/system.js');
    const { client, model } = createClient();
    const tmp = path.join(os.tmpdir(), `cheapai-live-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    const rt = createToolRuntime({ cwd: tmp });

    const messages = [
      { role: 'system', content: buildSystemPrompt({ cwd: tmp, model }) },
      {
        role: 'user',
        content:
          'Create a file named live-test.txt containing exactly the text PING using write_file tool. Then stop.',
      },
    ];

    let usedTool = false;
    for (let turn = 0; turn < 6; turn++) {
      const result = await chatWithTools({
        client,
        model,
        messages,
        tools: TOOL_DEFINITIONS,
        temperature: 0,
      });
      if (result.tool_calls?.length) {
        messages.push({
          role: 'assistant',
          content: result.content || null,
          tool_calls: result.tool_calls,
        });
        for (const tc of result.tool_calls) {
          usedTool = true;
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            /* */
          }
          const out = await rt.execute(tc.function.name, args);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(out),
          });
          ok(`live tool ${tc.function.name}`);
        }
        continue;
      }
      break;
    }

    const fp = path.join(tmp, 'live-test.txt');
    if (fs.existsSync(fp) && fs.readFileSync(fp, 'utf8').includes('PING')) {
      ok('live write_file via model');
    } else if (!usedTool) {
      bad('live tools', new Error('model did not call tools — gateway/model may lack tool calling'));
    } else {
      bad('live file', new Error('tool ran but file missing/wrong'));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) {
    bad('live LLM', e);
  }
}

console.log('');
if (failed) {
  console.error(`FAILED ${failed}`);
  process.exit(1);
}
console.log('ALL PASSED');
