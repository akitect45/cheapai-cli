import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dispatchResearch } from '../src/research/index.js';
import {
  appendRun,
  clearResearchFiles,
  createExperiment,
  decideRunStatus,
  findBestKeptMetric,
  flagRun,
  readExperiment,
  readRuns,
  researchPaths,
  summarize,
  writeExperiment,
} from '../src/research/runs.js';

function withWorkspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cheapai-research-'));
  const finish = () => fs.rmSync(root, { recursive: true, force: true });
  try {
    const result = fn(root);
    if (result && typeof result.then === 'function') return result.finally(finish);
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  }
}

test('ledger keep/discard honors direction and excludes flagged runs', () => withWorkspace((root) => {
  writeExperiment(root, createExperiment({
    name: 'latency',
    goal: 'cut p95',
    primaryMetric: 'latency_ms',
    direction: 'lower',
  }));
  appendRun(root, { command: 'a', status: 'keep', metric: 20, metrics: { latency_ms: 20 } });
  appendRun(root, { command: 'b', status: 'keep', metric: 12, metrics: { latency_ms: 12 } });
  appendRun(root, { command: 'c', status: 'discard', metric: 18, metrics: { latency_ms: 18 } });
  const hacked = appendRun(root, { command: 'd', status: 'keep', metric: 1, metrics: { latency_ms: 1 } });
  flagRun(root, hacked.runId, 'reward-hack');
  const experiment = readExperiment(root);
  const view = summarize(experiment, readRuns(root));
  assert.equal(view.baseline, 20);
  assert.equal(view.best, 12);
  assert.equal(view.flagged, 1);
  assert.equal(findBestKeptMetric(readRuns(root), 'higher'), 20);
}));

test('decideRunStatus maps crash, missing metric, keep, and discard', () => {
  assert.equal(decideRunStatus({ exitCode: 1, primary: 3, best: null, direction: 'lower' }), 'crash');
  assert.equal(decideRunStatus({ exitCode: 0, timedOut: true, primary: 3, best: null, direction: 'lower' }), 'crash');
  assert.equal(decideRunStatus({ exitCode: 0, primary: null, best: null, direction: 'lower' }), 'checks_failed');
  assert.equal(decideRunStatus({ exitCode: 0, primary: 9, best: null, direction: 'lower' }), 'keep');
  assert.equal(decideRunStatus({ exitCode: 0, primary: 11, best: 9, direction: 'lower' }), 'discard');
  assert.equal(decideRunStatus({ exitCode: 0, primary: 8, best: 9, direction: 'lower' }), 'keep');
});

test('research init/status/clear stay workspace-scoped', async () => withWorkspace(async (root) => {
  const missing = await dispatchResearch({ cwd: root, action: 'status' });
  assert.equal(missing.state.lifecycle, 'none');
  assert.equal(missing.nextAllowedActions.find((item) => item.verb === 'init').available, true);

  const created = await dispatchResearch({
    cwd: root,
    action: 'init',
    goal: 'measure echo',
    primaryMetric: 'latency_ms',
    direction: 'lower',
    command: `"${process.execPath}" -e "console.log('METRIC latency_ms=4')"`,
  });
  assert.equal(created.ok, true);
  assert.equal(created.state.lifecycle, 'ready');
  assert.equal(fs.existsSync(researchPaths(root).experimentPath), true);

  const duplicate = await dispatchResearch({ cwd: root, action: 'init', goal: 'again' });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.evidence.error, /experiment_exists/);

  const cleared = await dispatchResearch({ cwd: root, action: 'clear' });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.state.lifecycle, 'none');
  assert.equal(readExperiment(root), null);
  assert.deepEqual(clearResearchFiles(root).removed, []);
}));

test('research run parses METRIC output and flags a run', async () => withWorkspace(async (root) => {
  const command = `"${process.execPath}" -e "console.log('METRIC latency_ms=7'); console.log('ASI note=ok')"`;
  await dispatchResearch({
    cwd: root,
    action: 'init',
    goal: 'bench',
    primaryMetric: 'latency_ms',
    command,
  });
  const first = await dispatchResearch({ cwd: root, action: 'run' });
  assert.equal(first.ok, true);
  assert.equal(first.evidence.run.status, 'keep');
  assert.equal(first.evidence.run.metric, 7);
  assert.equal(first.evidence.run.asi.note, 'ok');
  assert.equal(first.state.best, 7);

  const worse = `"${process.execPath}" -e "console.log('METRIC latency_ms=9')"`;
  const second = await dispatchResearch({ cwd: root, action: 'run', command: worse });
  assert.equal(second.evidence.run.status, 'discard');
  assert.equal(second.state.best, 7);

  const flagged = await dispatchResearch({
    cwd: root,
    action: 'flag',
    runId: first.evidence.run.runId,
    reason: 'suspect',
  });
  assert.equal(flagged.ok, true);
  assert.equal(flagged.evidence.run.flagged, true);
  assert.equal(flagged.state.best, null);
}));
