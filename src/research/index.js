import { runProcess } from '../agent/process-runner.js';
import { resolveHarnessCommand } from './command.js';
import { parseHarnessOutput } from './harness.js';
import {
  appendRun,
  clearResearchFiles,
  completeRun,
  createExperiment,
  decideRunStatus,
  findRun,
  flagRun,
  readExperiment,
  readRuns,
  summarize,
  writeExperiment,
} from './runs.js';

const ACTIONS = ['init', 'run', 'status', 'flag', 'clear'];
const OUTPUT_CAP = 4 * 1024;

export function isResearchMutating(action) {
  return String(action || '') !== 'status';
}

export async function dispatchResearch(input = {}) {
  const cwd = input.cwd || process.cwd();
  const action = String(input.action || '').trim();
  if (!ACTIONS.includes(action)) {
    return response({
      ok: false,
      experiment: readExperiment(cwd),
      runs: readRuns(cwd),
      evidence: { error: `unknown_research_action:${action || 'missing'}` },
    });
  }
  try {
    if (action === 'init') return initResearch(cwd, input);
    if (action === 'run') return await runResearch(cwd, input);
    if (action === 'status') return statusResearch(cwd);
    if (action === 'flag') return flagResearch(cwd, input);
    return clearResearch(cwd);
  } catch (error) {
    return response({
      ok: false,
      experiment: readExperiment(cwd),
      runs: readRuns(cwd),
      evidence: { error: String(error?.message || error), code: error?.code || 'research_error' },
    });
  }
}

function initResearch(cwd, input) {
  const existing = readExperiment(cwd);
  if (existing) {
    return response({
      ok: false,
      experiment: existing,
      runs: readRuns(cwd),
      evidence: { error: 'experiment_exists', hint: 'Call research clear before init, or keep iterating with run.' },
    });
  }
  if (!String(input.goal || '').trim() && !String(input.primaryMetric || '').trim()) {
    return response({
      ok: false,
      experiment: null,
      runs: [],
      evidence: { error: 'init_requires_goal_or_metric' },
    });
  }
  const experiment = writeExperiment(cwd, createExperiment({
    name: input.name,
    goal: input.goal,
    primaryMetric: input.primaryMetric,
    direction: input.direction,
    preferredCommand: input.command || input.preferredCommand,
  }));
  return response({
    ok: true,
    experiment,
    runs: [],
    evidence: { experiment },
  });
}

async function runResearch(cwd, input) {
  const experiment = readExperiment(cwd);
  if (!experiment) {
    return response({
      ok: false,
      experiment: null,
      runs: [],
      evidence: { error: 'experiment_missing', hint: 'Call research init first.' },
    });
  }
  const resolved = resolveHarnessCommand({
    cwd,
    preferredCommand: input.command || experiment.preferredCommand,
  });
  if (!resolved.ok) {
    return response({
      ok: false,
      experiment,
      runs: readRuns(cwd),
      evidence: {
        error: resolved.error,
        hint: 'Pass command, or add autoresearch.sh / autoresearch.cmd / autoresearch.ps1 in the workspace.',
      },
    });
  }

  const startedAt = Date.now();
  const pending = appendRun(cwd, { command: resolved.command, startedAt });
  const processResult = await runProcess({
    command: resolved.command,
    cwd,
    timeoutMs: input.timeoutMs || 120_000,
    signal: input.signal || null,
    onStart: input.onProcess || null,
  });
  const parsed = parseHarnessOutput(
    `${processResult.stdout || ''}\n${processResult.stderr || ''}`,
    experiment.primaryMetric,
  );
  const runs = readRuns(cwd);
  const best = summarize(experiment, runs.filter((run) => run.runId !== pending.runId)).best;
  const status = decideRunStatus({
    exitCode: processResult.exit_code,
    timedOut: processResult.timed_out === true,
    aborted: processResult.aborted === true,
    primary: parsed.primary,
    best,
    direction: experiment.direction,
  });
  const run = completeRun(cwd, pending.runId, {
    status,
    metric: parsed.primary,
    metrics: parsed.metrics,
    asi: parsed.asi,
    exitCode: processResult.exit_code ?? null,
    timedOut: processResult.timed_out === true,
    aborted: processResult.aborted === true,
    durationMs: Date.now() - startedAt,
    description: input.description || null,
  });
  return response({
    ok: status !== 'crash' && !processResult.aborted,
    experiment,
    runs: readRuns(cwd),
    evidence: {
      run,
      command: resolved.command,
      commandSource: resolved.source,
      stdout: clip(processResult.stdout),
      stderr: clip(processResult.stderr),
      timed_out: processResult.timed_out === true,
      aborted: processResult.aborted === true,
    },
  });
}

function statusResearch(cwd) {
  const experiment = readExperiment(cwd);
  const runs = readRuns(cwd);
  const view = summarize(experiment, runs);
  return response({
    ok: true,
    experiment,
    runs,
    evidence: {
      experiment,
      baseline: view.baseline,
      best: view.best,
      flagged: view.flagged,
      recent: view.recent,
    },
  });
}

function flagResearch(cwd, input) {
  const experiment = readExperiment(cwd);
  const runs = readRuns(cwd);
  if (!experiment) {
    return response({
      ok: false,
      experiment: null,
      runs,
      evidence: { error: 'experiment_missing' },
    });
  }
  const target = findRun(runs, input.runId || input.run);
  if (!target) {
    return response({
      ok: false,
      experiment,
      runs,
      evidence: { error: 'research_run_not_found' },
    });
  }
  const run = flagRun(cwd, target.runId, input.reason || 'flagged');
  return response({
    ok: true,
    experiment,
    runs: readRuns(cwd),
    evidence: { run },
  });
}

function clearResearch(cwd) {
  const experiment = readExperiment(cwd);
  const runs = readRuns(cwd);
  const cleared = clearResearchFiles(cwd);
  return response({
    ok: true,
    experiment: null,
    runs: [],
    evidence: { cleared: cleared.removed, previous: { experiment, runCount: runs.length } },
  });
}

function response({ ok, experiment, runs, evidence }) {
  const view = summarize(experiment, runs);
  const lifecycle = !experiment ? 'none' : view.runCount === 0 ? 'ready' : 'running';
  return {
    ok,
    state: {
      lifecycle,
      runCount: view.runCount,
      baseline: view.baseline,
      best: view.best,
      primaryMetric: experiment?.primaryMetric || null,
      direction: experiment?.direction || null,
    },
    evidence,
    nextAllowedActions: nextAllowedActions(lifecycle, view.runCount),
  };
}

function nextAllowedActions(lifecycle, runCount) {
  const add = (verb, available, reason) => (available ? { verb, available } : { verb, available, reason });
  return [
    add('init', lifecycle === 'none', lifecycle === 'none' ? undefined : 'experiment_exists'),
    add('run', lifecycle !== 'none', lifecycle === 'none' ? 'experiment_missing' : undefined),
    add('status', true),
    add('flag', runCount > 0, runCount > 0 ? undefined : 'no_runs'),
    add('clear', lifecycle !== 'none', lifecycle === 'none' ? 'nothing_to_clear' : undefined),
  ];
}

function clip(text) {
  const value = String(text || '');
  if (value.length <= OUTPUT_CAP) return value;
  return `${value.slice(0, OUTPUT_CAP)}\n…[truncated]`;
}
