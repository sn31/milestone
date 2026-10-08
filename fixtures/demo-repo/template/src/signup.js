const { PLANS } = require('./pricing');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

// In-memory store: signups live only for the lifetime of the process.
const signups = new Map();
let nextId = 1;

function createSignup({ email, plan = 'starter' } = {}) {
  if (!validateEmail(email)) {
    throw new Error('invalid email');
  }
  if (!Object.prototype.hasOwnProperty.call(PLANS, plan)) {
    throw new Error('unknown plan');
  }
  const record = {
    id: String(nextId++),
    email: email.trim().toLowerCase(),
    plan,
  };
  signups.set(record.id, record);
  return record;
}

module.exports = { validateEmail, createSignup, signups };
