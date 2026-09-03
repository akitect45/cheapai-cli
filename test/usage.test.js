import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountHeaderLabel,
  accountUsageRows,
  isPlanBilling,
  planStatusRows,
  sessionUsageRows,
} from '../src/agent/usage.js';

const plan = {
  billingMode: 'plan',
  unit: 'percent',
  planTier: 'plus',
  period: 'week',
  periodEnd: '2026-09-08T12:00:00.000Z',
  usedPercent: 25,
  remainingPercent: 75,
  extraCredits: 0,
  remainingOk: true,
  username: 'plus-user',
  metrics: { requests: 3, tokens: 1200 },
  key: { name: 'CheapAI APP', creditsUsed: 10, creditsRemaining: null },
};

test('plan billing is detected from billingMode, unit, or remainingPercent', () => {
  assert.equal(isPlanBilling(plan), true);
  assert.equal(isPlanBilling({ unit: 'percent', remainingPercent: 40 }), true);
  assert.equal(isPlanBilling({ remainingPercent: 0 }), true);
  assert.equal(isPlanBilling({ extraCredits: 0, remainingOk: true }), true);
  assert.equal(isPlanBilling({ billingMode: 'usage', unit: 'credits', balance: 9000 }), false);
  assert.equal(isPlanBilling({}), false);
});

test('plan header shows remaining percent and extra credits, never won', () => {
  assert.equal(accountHeaderLabel(plan), '75% left');
  assert.equal(accountHeaderLabel({ ...plan, extraCredits: 1500 }), '75% left · extra 1.5k');
  assert.equal(accountHeaderLabel({
    ...plan,
    remainingPercent: 0,
    extraCredits: 500,
    remainingOk: true,
  }), '0% left · extra 500');
  assert.equal(accountHeaderLabel({
    ...plan,
    remainingPercent: 0,
    extraCredits: 0,
    remainingOk: false,
  }), 'plan empty');
  assert.equal(accountHeaderLabel(null), null);
  assert.ok(!String(accountHeaderLabel({ balance: 12345 }) || '').includes('₩'));
});

test('live /v1/usage snapshot does not treat spendable credits as quota', () => {
  const live = {
    object: 'cheapai.usage',
    billingMode: 'plan',
    unit: 'percent',
    planTier: 'plus',
    credits: 27500,
    balance: 27500,
    remaining: 22500,
    periodLimit: 30000,
    periodUsed: 7500,
    usedPercent: 25,
    remainingPercent: 75,
    extraCredits: 5000,
    remainingOk: true,
    spentToday: 1200,
    spentMonth: 4000,
    metrics: { requests: 3, tokens: 1200, spent: 800 },
    usage: { credits: 27500, requests_12h: 3, tokens_12h: 1200, spent_12h: 800 },
  };
  assert.equal(accountHeaderLabel(live), '75% left · extra 5k');
  const shown = JSON.stringify(accountUsageRows(live));
  assert.ok(!shown.includes('₩'));
  assert.ok(!shown.includes('27500'));
  assert.ok(!shown.includes('30000'));
  assert.ok(!shown.includes('22500'));
  const rows = Object.fromEntries(accountUsageRows(live));
  assert.equal(rows.left, '75%');
  assert.equal(rows['extra credits'], '5,000');
});

test('plan usage rows hide spend and periodLimit', () => {
  const rows = Object.fromEntries(accountUsageRows(plan));
  assert.equal(rows.plan, 'Plus');
  assert.equal(rows.used, '25%');
  assert.equal(rows.left, '75%');
  assert.equal(rows['extra credits'], '0');
  assert.equal(rows['can send'], 'yes');
  assert.equal(rows.period, 'week');
  assert.ok(!('balance' in rows));
  assert.ok(!('today' in rows));
  assert.ok(!('this month' in rows));
  assert.ok(!('12h spent' in rows));
  assert.ok(!String(JSON.stringify(rows)).includes('₩'));
  assert.ok(!String(JSON.stringify(rows)).includes('30000'));
});

test('empty plan tells the user to top up extra credits', () => {
  const rows = Object.fromEntries(accountUsageRows({
    ...plan,
    remainingPercent: 0,
    usedPercent: 100,
    extraCredits: 0,
    remainingOk: false,
  }));
  assert.equal(rows.left, '0%');
  assert.equal(rows['can send'], 'no — top up extra credits');
});

test('session usage rows are tokens only', () => {
  const rows = Object.fromEntries(sessionUsageRows({
    requests: 2,
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
    credits: 12.5,
  }));
  assert.equal(rows.requests, '2');
  assert.equal(rows['total tokens'], '140');
  assert.ok(!('billed' in rows));
});

test('plan status rows omit session billed and wallet won', () => {
  const rows = Object.fromEntries(planStatusRows(plan));
  assert.equal(rows.plan, 'Plus');
  assert.equal(rows.left, '75%');
  assert.equal(rows['extra credits'], '0');
  assert.ok(!String(JSON.stringify(rows)).includes('₩'));
});
