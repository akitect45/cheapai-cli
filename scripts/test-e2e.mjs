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
}

// 2) tools runtime
{
  const { createToolRuntime, TOOL_DEFINITIONS } = await import('../src/agent/tools.js');
  if (TOOL_DEFINITIONS.length < 6) bad('tool defs', new Error('count ' + TOOL_DEFINITIONS.length));
  else ok(`tool definitions (${TOOL_DEFINITIONS.length})`);

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
  const { normalizePollResult } = await import('../src/auth.js');
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
}

// 4) device endpoints shape
if (process.argv.includes('--poll-shape') || process.argv.includes('--live')) {
  try {
    const { startDeviceAuth, pollDeviceAuth } = await import('../src/auth.js');
    const d = await startDeviceAuth();
    ok(`device/code user_code=${d.user_code}`);
    const p = await pollDeviceAuth({ deviceCode: d.device_code });
    ok(`device/poll status=${p.status}`);
    console.log('  raw poll:', JSON.stringify(p.raw || p).slice(0, 300));
  } catch (e) {
    bad('device endpoints', e);
  }
}

// 5) live LLM + tools (optional)
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
