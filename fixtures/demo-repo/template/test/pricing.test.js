const { test } = require('node:test');
const assert = require('node:assert/strict');
const pricing = require('../src/pricing');
const { PLANS } = pricing;

test('every plan has a positive monthly price', () => {
  for (const plan of Object.values(PLANS)) {
    assert.ok(plan.monthlyCents > 0, plan.name);
  }
});

test('starter is the cheapest plan', () => {
  const prices = Object.values(PLANS).map((plan) => plan.monthlyCents);
  assert.equal(PLANS.starter.monthlyCents, Math.min(...prices));
});

// Acceptance test for annual billing (the pricing page milestone), written ahead of the work.
// It is skipped until src/pricing.js exports annualPriceCents, then it grades the delivery.
const annualBuilt = typeof pricing.annualPriceCents === 'function';
test('annual billing gives 20% off twelve months', { skip: annualBuilt ? false : 'annual billing is not built yet' }, () => {
  assert.equal(pricing.annualPriceCents('pro'), Math.round(PLANS.pro.monthlyCents * 12 * 0.8));
});
