const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PLANS } = require('../src/pricing');

test('every plan has a positive monthly price', () => {
  for (const plan of Object.values(PLANS)) {
    assert.ok(plan.monthlyCents > 0, plan.name);
  }
});

test('starter is the cheapest plan', () => {
  const prices = Object.values(PLANS).map((plan) => plan.monthlyCents);
  assert.equal(PLANS.starter.monthlyCents, Math.min(...prices));
});
