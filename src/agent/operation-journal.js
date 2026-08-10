import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureHome, homeDir } from '../config.js';
import { assertSessionId, atomicWriteFile } from './session-format.js';
import { terminateRecordedProcess } from './process-runner.js';

const NONTERMINAL_STATES = new Set(['received', 'started']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'uncertain']);
const MAX_RESULT_BYTES = 80_000;

export function createOperationJournal({ sessionId, onRecord = null } = {}) {
  const id = assertSessionId(sessionId);
  ensureHome();
  const filePath = path.join(homeDir(), 'recovery', `${id}.operations.jsonl`);

  function records() {
    return readRecords(filePath);
  }

  function latest(operationId) {
    return records().filter((record) => record.operationId === operationId).at(-1) || null;
  }

  function append(state, operationId, data = {}) {
    const record = {
      version: 1,
      id: crypto.randomUUID(),
      sessionId: id,
      operationId: String(operationId),
      state,
      timestamp: new Date().toISOString(),
      ...data,
    };
    appendRecord(filePath, record);
    onRecord?.(record);
    return record;
  }

  return {
    filePath,
    recover() {
      const lastByOperation = latestRecords(records());
      const uncertain = [];
      for (const record of lastByOperation.values()) {
        if (!NONTERMINAL_STATES.has(record.state)) continue;
        if (record.process) terminateRecordedProcess(record.process);
        uncertain.push(append('uncertain', record.operationId, {
          tool: record.tool,
          argsHash: record.argsHash,
          reason: 'Process exited before a terminal operation result was durable.',
          process: record.process || null,
        }));
      }
      return uncertain;
    },
    begin({ operationId, tool, args }) {
      const prior = latest(operationId);
      if (prior && TERMINAL_STATES.has(prior.state)) {
        if (prior.argsHash && prior.argsHash !== hashArguments(args)) {
          const error = new Error(`Operation id was reused with different arguments: ${operationId}`);
          error.code = 'operation_id_conflict';
          throw error;
        }
        return { execute: false, record: prior, result: prior.result };
      }
      if (prior && NONTERMINAL_STATES.has(prior.state)) {
        if (prior.argsHash && prior.argsHash !== hashArguments(args)) {
          const error = new Error(`Operation id was reused with different arguments: ${operationId}`);
          error.code = 'operation_id_conflict';
          throw error;
        }
        const uncertain = append('uncertain', operationId, {
          tool: prior.tool || tool,
          argsHash: prior.argsHash || hashArguments(args),
          reason: 'Duplicate admission found a nonterminal operation.',
          process: prior.process || null,
        });
        return { execute: false, record: uncertain, result: null };
      }
      const base = { tool, argsHash: hashArguments(args) };
      append('received', operationId, base);
      const started = append('started', operationId, base);
      return { execute: true, record: started, result: null };
    },
    processStarted(operationId, processRecord) {
      const prior = latest(operationId);
      return append('started', operationId, {
        tool: prior?.tool,
        argsHash: prior?.argsHash,
        process: processRecord,
      });
    },
    complete(operationId, result) {
      const prior = latest(operationId);
      return append('completed', operationId, {
        tool: prior?.tool,
        argsHash: prior?.argsHash,
        result: boundedResult(result),
        process: prior?.process || null,
      });
    },
    fail(operationId, result) {
      const prior = latest(operationId);
      return append('failed', operationId, {
        tool: prior?.tool,
        argsHash: prior?.argsHash,
        result: boundedResult(result),
        process: prior?.process || null,
      });
    },
    latest,
    records,
  };
}

export function recoverOperationJournal(sessionId, options = {}) {
  return createOperationJournal({ sessionId, ...options }).recover();
}

function readRecords(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  const records = [];
  const validLines = [];
  let repaired = false;
  const lastContentIndex = lines.reduce((last, line, index) => line.trim() ? index : last, -1);
  for (let index = 0; index <= lastContentIndex; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
      validLines.push(line);
    } catch (error) {
      if (index !== lastContentIndex) {
        const invalid = new Error(`Malformed operation journal at line ${index + 1}: ${error.message}`);
        invalid.code = 'invalid_operation_journal';
        throw invalid;
      }
      repaired = true;
    }
  }
  if (repaired) atomicWriteFile(filePath, validLines.length ? `${validLines.join('\n')}\n` : '');
  return records;
}

function appendRecord(filePath, record) {
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    fs.fsyncSync(fd);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* Windows may ignore POSIX modes. */
    }
  } finally {
    fs.closeSync(fd);
  }
}

function latestRecords(records) {
  const values = new Map();
  for (const record of records) values.set(record.operationId, record);
  return values;
}

function hashArguments(args) {
  return crypto.createHash('sha256').update(stableJson(args)).digest('hex');
}

function stableJson(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function boundedResult(result) {
  const json = JSON.stringify(result ?? null);
  if (Buffer.byteLength(json) <= MAX_RESULT_BYTES) return result ?? null;
  return {
    truncated: true,
    preview: json.slice(0, MAX_RESULT_BYTES),
  };
}
