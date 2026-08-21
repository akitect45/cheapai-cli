import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseAskQuestion, runAskQuestion } from '../src/agent/ask-question.js';
import { handleProjectDocs, looksLarge, listMarkdownDocs } from '../src/agent/project-docs.js';
import { parseSuggestions, fallbackFollowups } from '../src/agent/followups.js';
import { manageSkill, isSkillMutating } from '../src/agent/skill-store.js';
import { MCP_CATALOG, isMcpMutating, createMcpManager } from '../src/agent/mcp.js';
import { subagentTitle } from '../src/agent/subagent.js';
import { createToolRuntime, GOAL_TOOL_NAMES } from '../src/agent/tools.js';
import { discoverSkills } from '../src/resources/skills.js';

test('ask_question parses string and object options', () => {
  const parsed = parseAskQuestion({
    prompt: 'Pick one',
    options: ['Docs first', { id: 'code', label: 'Code first' }, { id: 'code', label: 'Dup' }],
  });
  assert.equal(parsed.prompt, 'Pick one');
  assert.equal(parsed.options.length, 2);
  assert.equal(parsed.options[0].id, '1');
  assert.equal(parsed.options[1].id, 'code');
  assert.equal(parseAskQuestion({ options: ['only'] }).error.includes('two'), true);
});

test('ask_question skips in yolo and rejects subagents', async () => {
  const skipped = await runAskQuestion({ prompt: 'x', options: ['a', 'b'] }, { yolo: true });
  assert.equal(skipped.skipped, true);
  const denied = await runAskQuestion({ prompt: 'x', options: ['a', 'b'] }, { isSubagent: true });
  assert.match(denied.error, /Subagents/);
  const picked = await runAskQuestion({ prompt: 'x', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, {
    askQuestion: async () => ({ id: 'b', label: 'B' }),
  });
  assert.deepEqual(picked, { ok: true, selected: 'b', label: 'B' });
});

test('project_docs lists markdown and resolve_conflict needs a source', () => withHome((root) => {
  assert.equal(looksLarge('이 기능을 전체 모듈로 리팩터해줘'), true);
  assert.equal(looksLarge('ok'), false);
  assert.deepEqual(listMarkdownDocs(root), []);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'plan.md'), '# plan\n');
  const status = handleProjectDocs({ action: 'status' }, root, {});
  assert.equal(status.missing, false);
  assert.deepEqual(status.files, ['docs/plan.md']);
  assert.match(handleProjectDocs({ action: 'resolve_conflict' }, root, {}).error, /source-of-truth/);
  assert.equal(handleProjectDocs({ action: 'resolve_conflict' }, root, { projectDocs: { source: 'docs' } }).source, 'docs');
}));

test('followup JSON parse keeps three unique suggestions', () => {
  const parsed = parseSuggestions('```json\n{"suggestions":[{"id":"verify","text":"아직 검증되지 않은 가정을 확인해줘","intent":"verify"},{"id":"gap","text":"빠진 에러 처리와 엣지 케이스를 찾아줘","intent":"gap"},{"id":"next-step","text":"다음 작업을 우선순위로 정리해줘","intent":"next_step"}]}\n```');
  assert.equal(parsed.length, 3);
  assert.equal(fallbackFollowups().length, 3);
});

test('skill CRUD writes SKILL.md and skips disabled discovery', () => withHome((root) => {
  const created = manageSkill({
    action: 'create',
    name: 'Review Notes',
    description: 'Review',
    instructions: 'Read the diff and list risks.',
  }, root);
  assert.equal(created.ok, true);
  assert.equal(created.skill.name, 'review-notes');
  assert.equal(discoverSkills(root).some((skill) => skill.name === 'review-notes'), true);
  manageSkill({ action: 'disable', name: 'review-notes' }, root);
  assert.equal(discoverSkills(root).some((skill) => skill.name === 'review-notes'), false);
  assert.equal(discoverSkills(root, { includeDisabled: true }).some((skill) => skill.name === 'review-notes'), true);
  assert.equal(isSkillMutating('list'), false);
  assert.equal(isSkillMutating('create'), true);
}));

test('mcp catalog and mutate flags', async () => {
  assert.equal(MCP_CATALOG.some((item) => item.id === 'github'), true);
  assert.equal(isMcpMutating('list_mcp_tools'), false);
  assert.equal(isMcpMutating('mcp_manage', { action: 'list' }), false);
  assert.equal(isMcpMutating('mcp_manage', { action: 'connect' }), true);
  assert.equal(isMcpMutating('call_mcp_tool', { server: 'x', tool: 'y' }), true);
  const manager = createMcpManager({ cwd: process.cwd(), servers: {} });
  const catalog = await manager.manage({ action: 'catalog' });
  assert.equal(catalog.builtin.length, MCP_CATALOG.length);
});

test('subagent title and parent-only tools stay out of child runtime', () => withHome((root) => {
  assert.equal(subagentTitle({ title: 'Auth tests' }), 'Auth tests');
  assert.equal(subagentTitle({ prompt: 'Write unit tests\nmore' }), 'Write unit tests');
  const runtime = createToolRuntime({ cwd: root, includeParentTools: false });
  assert.equal(runtime.registry.get('task') == null, true);
  assert.equal(runtime.registry.get('ask_question') == null, true);
  assert.equal(runtime.registry.get('web_fetch') != null, true);
  assert.equal(GOAL_TOOL_NAMES.has('ask_question'), true);
  assert.equal(GOAL_TOOL_NAMES.has('task'), false);
}));

function withHome(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheapai-features-'));
  const previous = process.env.CHEAPAI_HOME;
  process.env.CHEAPAI_HOME = path.join(root, '.cheapai-home');
  return Promise.resolve(callback(root)).finally(() => {
    if (previous === undefined) delete process.env.CHEAPAI_HOME;
    else process.env.CHEAPAI_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}
