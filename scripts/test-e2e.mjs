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
