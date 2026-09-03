import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASI_LINE_PREFIX,
  DEFAULT_HARNESS_COMMAND,
  HARNESS_FILENAME,
  METRIC_LINE_PREFIX,
  inferMetricUnitFromName,
  isBetter,
  parseAsiLines,
  parseHarnessOutput,
  parseMetricLines,
} from '../src/research/harness.js';

test('research harness defines the METRIC/ASI contract', () => {
  assert.equal(HARNESS_FILENAME, 'autoresearch.sh');
  assert.equal(DEFAULT_HARNESS_COMMAND, 'bash autoresearch.sh');
  assert.equal(METRIC_LINE_PREFIX, 'METRIC');
  assert.equal(ASI_LINE_PREFIX, 'ASI');
});

test('parseMetricLines keeps well-formed values and ignores noise', () => {
  const metrics = parseMetricLines([
    'building benchmark...',
    'METRIC latency_ms=12.5',
    'some progress line',
    'METRIC peak_mem_mb=1024',
    'done',
  ].join('\n'));
  assert.equal(metrics.get('latency_ms'), 12.5);
  assert.equal(metrics.get('peak_mem_mb'), 1024);
  assert.equal(metrics.size, 2);
});

test('parseMetricLines drops malformed and prototype-polluting keys', () => {
  const metrics = parseMetricLines([
    'METRIC no-equals',
    'METRIC =5',
    'METRIC name=',
    'METRIC __proto__=7',
    'METRIC constructor=7',
    'METRIC nan=NaN',
    'METRIC inf=Infinity',
    'not even a metric line',
    'METRIC valid=3',
  ].join('\n'));
  assert.equal(metrics.size, 1);
  assert.equal(metrics.get('valid'), 3);
});

test('parseAsiLines types values and ignores junk', () => {
  const asi = parseAsiLines([
    'ASI hypothesis=vectorized loop is bound on cache',
    'ASI success=true',
    'ASI count=42',
    'ASI ratio=0.5',
    'ASI nothing=null',
    'ASI tags=["a","b"]',
    'ASI meta={"x":1}',
    'ASI broken',
    'ASI =value',
    'ASI __proto__=pwn',
  ].join('\n'));
  assert.equal(asi.hypothesis, 'vectorized loop is bound on cache');
  assert.equal(asi.success, true);
  assert.equal(asi.count, 42);
  assert.equal(asi.ratio, 0.5);
  assert.equal(asi.nothing, null);
  assert.deepEqual(asi.tags, ['a', 'b']);
  assert.deepEqual(asi.meta, { x: 1 });
  assert.equal(Object.hasOwn(asi, '__proto__'), false);
  assert.equal(parseAsiLines('no asi lines here\nASI broken'), null);
});

test('parseHarnessOutput surfaces primary, secondaries, and ASI', () => {
  const parsed = parseHarnessOutput([
    'compiling...',
    'METRIC latency_ms=9.4',
    'ASI rollback_reason=none',
    'METRIC throughput=1200',
    'exit',
  ].join('\n'), 'latency_ms');
  assert.equal(parsed.primary, 9.4);
  assert.deepEqual(parsed.metrics, { latency_ms: 9.4, throughput: 1200 });
  assert.deepEqual(parsed.asi, { rollback_reason: 'none' });
  assert.equal(parseHarnessOutput('METRIC first=1\nMETRIC second=2').primary, 1);
  assert.equal(parseHarnessOutput('no metrics', 'latency_ms').primary, null);
});

test('isBetter and unit inference follow metric direction', () => {
  assert.equal(isBetter(3, 5, 'lower'), true);
  assert.equal(isBetter(5, 3, 'lower'), false);
  assert.equal(isBetter(5, 3, 'higher'), true);
  assert.equal(isBetter(3, 5, 'higher'), false);
  assert.equal(inferMetricUnitFromName('latency_ms'), 'ms');
  assert.equal(inferMetricUnitFromName('latency_µs'), 'µs');
  assert.equal(inferMetricUnitFromName('build_s'), 's');
  assert.equal(inferMetricUnitFromName('mem_mb'), 'mb');
  assert.equal(inferMetricUnitFromName('score'), '');
});
