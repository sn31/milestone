# Signup landing page (demo)

A tiny plain Node.js project with no dependencies. It models the signup flow of a SaaS landing page.

- `src/pricing.js` holds the plan table (prices in integer cents).
- `src/signup.js` exports `validateEmail` and `createSignup`. Signups are kept in memory.
- `public/index.html` is the signup form.
- `test/` uses `node:test`.

Run the tests:

    npm install
    npm test
