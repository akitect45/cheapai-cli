import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadCustomCommands, renderCustomCommand } from '../src/agent/commands.js';
import { discoverSkills } from '../src/resources/skills.js';
import { loadExtensions } from '../src/resources/extensions.js';
import { buildSystemPrompt } from '../src/prompts/system.js';
import { createToolRuntime } from '../src/agent/tools.js';

test('commands expose nearest-project provenance while keeping old facade shape', () => withWorkspace((root) => {
  const nested = path.join(root, 'nested');
  fs.mkdirSync(path.join(root, '.cheapai', 'commands'), { recursive: true });
  fs.mkdirSync(path.join(nested, '.cheapai', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(root, '.cheapai', 'commands', 'review.md'), '---\ndescription: parent\n---\nparent $ARGUMENTS');
  fs.writeFileSync(path.join(nested, '.cheapai', 'commands', 'review.md'), '---\ndescription: nested\n---\nnested $ARGUMENTS');
  const commands = loadCustomCommands(nested);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].description, 'nested');
  assert.equal(commands[0].scope, 'project');
  assert.equal(commands[0].provenance, nested);
  assert.equal(renderCustomCommand(commands[0], 'API'), 'nested API');
}));

test('skills are bounded context discovery and never executed', () => withWorkspace((root) => {
  const skillPath = path.join(root, '.cheapai', 'skills', 'review', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, '---\ndescription: Review safely\n---\nCall no executable content.');
  const skills = discoverSkills(root);
  assert.equal(skills[0].name, 'review');
  assert.equal(skills[0].description, 'Review safely');
  assert.equal(skills[0].body.includes('Call no executable content.'), true);
  assert.equal(buildSystemPrompt({ cwd: root, model: 'test' }).includes('Call no executable content.'), true);
}));

test('extensions require explicit path or hash approval and isolate failures', async () => withWorkspace(async (root) => {
  const extensionPath = path.join(root, '.cheapai', 'extensions', 'example.mjs');
  const badPath = path.join(root, '.cheapai', 'extensions', 'bad.mjs');
  const typescriptPath = path.join(root, '.cheapai', 'extensions', 'typed.ts');
  fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
  fs.writeFileSync(extensionPath, 'export default ({ registerTool }) => registerTool({ name: "example", description: "Example", parameters: {}, execute() {} });');
  fs.writeFileSync(badPath, 'export default ({ registerTool }) => { registerTool({ name: "partial", description: "Partial", parameters: {}, execute() {} }); throw new Error("broken"); };');
  fs.writeFileSync(typescriptPath, 'type Api = { registerCommand(value: { name: string; template: string }): void }; export default (api: Api) => api.registerCommand({ name: "typed", template: "typed command" });');
  const notices = [];
  const hash = crypto.createHash('sha256').update(fs.readFileSync(extensionPath)).digest('hex');
  const loaded = await loadExtensions({
    cwd: root,
    approvedPaths: [{ path: extensionPath, sha256: hash }, badPath, typescriptPath],
    onNotice: (message) => notices.push(message),
  });
  assert.equal(loaded.extensions.length, 2);
  assert.equal(loaded.tools[0].name, 'example');
  assert.equal(loaded.tools.some((tool) => tool.name === 'partial'), false);
  assert.equal(loaded.commands.some((command) => command.name === 'typed'), true);
  const runtime = createToolRuntime({ cwd: root, customTools: loaded.tools });
  assert.deepEqual(await runtime.execute('example', {}), { ok: true });
  assert.equal(notices.some((message) => message.includes('failed to load')), true);

  const relativeApproval = path.relative(process.cwd(), extensionPath);
  const rejected = await loadExtensions({ cwd: root, approvedPaths: [relativeApproval] });
  assert.equal(rejected.extensions.length, 0);
}));

function withWorkspace(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheapai-resources-test-'));
  const previous = process.env.CHEAPAI_HOME;
  process.env.CHEAPAI_HOME = path.join(root, '.cheapai-home');
  return Promise.resolve(callback(root)).finally(() => {
    if (previous === undefined) delete process.env.CHEAPAI_HOME;
    else process.env.CHEAPAI_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}
