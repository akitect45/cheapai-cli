import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../agent/session-format.js';
import { inferMetricUnitFromName, isBetter, sanitizeMetrics } from './harness.js';

const STATUSES = new Set(['keep', 'discard', 'crash', 'checks_failed']);

export function researchDir(cwd) {
  return path.join(path.resolve(cwd || process.cwd()), '.cheapai', 'autoresearch');
}

export function researchPaths(cwd) {
  const dir = researchDir(cwd);
  return {
    dir,
    experimentPath: path.join(dir, 'experiment.json'),
    runsPath: path.join(dir, 'runs.jsonl'),
    verdictPath: path.join(dir, 'verdict.md'),
  };
}

export function createExperiment(input = {}) {
  const name = String(input.name || 'research').trim() || 'research';
  const primaryMetric = String(input.primaryMetric || 'metric').trim() || 'metric';
  const direction = input.direction === 'higher' ? 'higher' : 'lower';
  const preferred = typeof input.preferredCommand === 'string' ? input.preferredCommand.trim() : '';
  return {
    name,
    goal: typeof input.goal === 'string' && input.goal.trim() ? input.goal.trim() : null,
    primaryMetric,
    metricUnit: input.metricUnit || inferMetricUnitFromName(primaryMetric),
    direction,
    preferredCommand: preferred || null,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function readExperiment(cwd) {
  const { experimentPath } = researchPaths(cwd);
  if (!fs.existsSync(experimentPath)) return null;
  try {
    return normalizeExperiment(JSON.parse(fs.readFileSync(experimentPath, 'utf8')));
  } catch {
    return null;
  }
}

export function writeExperiment(cwd, experiment) {
  const { experimentPath } = researchPaths(cwd);
  atomicWriteFile(experimentPath, `${JSON.stringify(experiment, null, 2)}\n`);
  return experiment;
}

export function readRuns(cwd) {
  const { runsPath } = researchPaths(cwd);
  if (!fs.existsSync(runsPath)) return [];
  const records = [];
  for (const line of fs.readFileSync(runsPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = normalizeRun(JSON.parse(trimmed));
      if (record) records.push(record);
    } catch {
      /* ignore malformed ledger lines */
    }
  }
  return records;
}

export function appendRun(cwd, input = {}) {
  const runs = readRuns(cwd);
  const runNumber = runs.reduce((max, run) => Math.max(max, run.runNumber), 0) + 1;
  const record = {
    runId: crypto.randomUUID(),
    runNumber,
    command: String(input.command || ''),
    startedAt: input.startedAt ?? Date.now(),
    completedAt: input.completedAt ?? null,
    durationMs: input.durationMs ?? null,
    exitCode: input.exitCode ?? null,
    timedOut: input.timedOut === true,
    aborted: input.aborted === true,
    status: normalizeStatus(input.status),
    description: typeof input.description === 'string' ? input.description : null,
    metric: finiteOrNull(input.metric),
    metrics: sanitizeMetrics(input.metrics),
    asi: input.asi && typeof input.asi === 'object' ? input.asi : null,
    flagged: input.flagged === true,
    flaggedReason: typeof input.flaggedReason === 'string' ? input.flaggedReason : null,
  };
  const { runsPath } = researchPaths(cwd);
  fs.mkdirSync(path.dirname(runsPath), { recursive: true });
  fs.appendFileSync(runsPath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export function completeRun(cwd, runId, patch = {}) {
  return updateRun(cwd, runId, (current) => ({
    ...current,
    ...pickRunPatch(patch),
    completedAt: patch.completedAt ?? Date.now(),
    durationMs: patch.durationMs ?? current.durationMs,
  }));
}

export function flagRun(cwd, runId, reason) {
  return updateRun(cwd, runId, (current) => ({
    ...current,
    flagged: true,
    flaggedReason: String(reason || 'flagged'),
  }));
}

export function clearResearchFiles(cwd) {
  const paths = researchPaths(cwd);
  const removed = [];
  for (const filePath of [paths.experimentPath, paths.runsPath, paths.verdictPath]) {
    if (!fs.existsSync(filePath)) continue;
    fs.unlinkSync(filePath);
    removed.push(filePath);
  }
  return { removed, dir: paths.dir };
}

export function findRun(runs, ref) {
  const token = String(ref || '').trim();
  if (!token) return null;
  const exact = runs.find((run) => run.runId === token);
  if (exact) return exact;
  const byNumber = runs.find((run) => String(run.runNumber) === token);
  if (byNumber) return byNumber;
  const matches = runs.filter((run) => run.runId.startsWith(token));
  return matches.length === 1 ? matches[0] : null;
}

export function findBaselineMetric(runs, directionIgnored) {
  void directionIgnored;
  const baseline = runs.find((run) => run.status === 'keep' && !run.flagged && run.metric !== null);
  return baseline ? baseline.metric : null;
}

export function findBestKeptMetric(runs, direction) {
  let best = null;
  for (const run of runs) {
    if (run.status !== 'keep' || run.flagged || run.metric === null) continue;
    if (best === null || isBetter(run.metric, best, direction)) best = run.metric;
  }
  return best;
}

export function decideRunStatus({ exitCode, timedOut, aborted, primary, best, direction }) {
  if (aborted || timedOut || exitCode !== 0) return 'crash';
  if (primary === null || !Number.isFinite(primary)) return 'checks_failed';
  if (best === null) return 'keep';
  return isBetter(primary, best, direction) ? 'keep' : 'discard';
}

export function summarize(experiment, runs) {
  const logged = (runs || []).filter((run) => run.status);
  const direction = experiment?.direction || 'lower';
  return {
    experiment: experiment || null,
    runCount: logged.length,
    baseline: experiment ? findBaselineMetric(logged) : null,
    best: experiment ? findBestKeptMetric(logged, direction) : null,
    flagged: logged.filter((run) => run.flagged).length,
    recent: logged.slice(-8),
  };
}

function updateRun(cwd, runId, mutate) {
  const runs = readRuns(cwd);
  const index = runs.findIndex((run) => run.runId === runId);
  if (index < 0) {
    const error = new Error(`Research run not found: ${runId}`);
    error.code = 'research_run_not_found';
    throw error;
  }
  const next = mutate(runs[index]);
  runs[index] = next;
  const { runsPath } = researchPaths(cwd);
  atomicWriteFile(runsPath, runs.map((run) => JSON.stringify(run)).join('\n') + (runs.length ? '\n' : ''));
  return next;
}

function normalizeExperiment(value) {
  if (typeof value !== 'object' || value === null) return null;
  if (typeof value.name !== 'string' || !value.name) return null;
  return createExperiment({
    name: value.name,
    goal: value.goal,
    primaryMetric: value.primaryMetric,
    metricUnit: typeof value.metricUnit === 'string' ? value.metricUnit : undefined,
    direction: value.direction,
    preferredCommand: value.preferredCommand,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
  });
}

function normalizeRun(value) {
  if (typeof value !== 'object' || value === null) return null;
  if (typeof value.runId !== 'string' || !value.runId) return null;
  return {
    runId: value.runId,
    runNumber: typeof value.runNumber === 'number' ? value.runNumber : 0,
    command: typeof value.command === 'string' ? value.command : '',
    startedAt: typeof value.startedAt === 'number' ? value.startedAt : 0,
    completedAt: typeof value.completedAt === 'number' ? value.completedAt : null,
    durationMs: typeof value.durationMs === 'number' ? value.durationMs : null,
    exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
    timedOut: value.timedOut === true,
    aborted: value.aborted === true,
    status: normalizeStatus(value.status),
    description: typeof value.description === 'string' ? value.description : null,
    metric: finiteOrNull(value.metric),
    metrics: sanitizeMetrics(value.metrics),
    asi: value.asi && typeof value.asi === 'object' ? value.asi : null,
    flagged: value.flagged === true,
    flaggedReason: typeof value.flaggedReason === 'string' ? value.flaggedReason : null,
  };
}

function pickRunPatch(patch) {
  const next = {};
  if ('command' in patch) next.command = String(patch.command || '');
  if ('exitCode' in patch) next.exitCode = patch.exitCode ?? null;
  if ('timedOut' in patch) next.timedOut = patch.timedOut === true;
  if ('aborted' in patch) next.aborted = patch.aborted === true;
  if ('status' in patch) next.status = normalizeStatus(patch.status);
  if ('description' in patch) next.description = typeof patch.description === 'string' ? patch.description : null;
  if ('metric' in patch) next.metric = finiteOrNull(patch.metric);
  if ('metrics' in patch) next.metrics = sanitizeMetrics(patch.metrics);
  if ('asi' in patch) next.asi = patch.asi && typeof patch.asi === 'object' ? patch.asi : null;
  if ('flagged' in patch) next.flagged = patch.flagged === true;
  if ('flaggedReason' in patch) next.flaggedReason = typeof patch.flaggedReason === 'string' ? patch.flaggedReason : null;
  return next;
}

function normalizeStatus(value) {
  return STATUSES.has(value) ? value : null;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
