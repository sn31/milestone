const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateEmail, createSignup } = require('../src/signup');

test('validateEmail accepts a normal address', () => {
  assert.equal(validateEmail('ada@example.com'), true);
});

test('validateEmail rejects malformed input', () => {
  assert.equal(validateEmail('not-an-email'), false);
  assert.equal(validateEmail(''), false);
  assert.equal(validateEmail(null), false);
});

test('createSignup stores a normalised record', () => {
  const record = createSignup({ email: ' Ada@Example.com ', plan: 'pro' });
  assert.equal(record.email, 'ada@example.com');
  assert.equal(record.plan, 'pro');
  assert.ok(record.id);
});

test('createSignup defaults to the starter plan', () => {
  const record = createSignup({ email: 'grace@example.com' });
  assert.equal(record.plan, 'starter');
});

test('createSignup rejects an invalid email', () => {
  assert.throws(() => createSignup({ email: 'bad', plan: 'pro' }), /invalid email/);
});

test('createSignup rejects an unknown plan', () => {
  assert.throws(() => createSignup({ email: 'linus@example.com', plan: 'enterprise' }), /unknown plan/);
});
