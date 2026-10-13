# Real-repo deliveries

This shows the deterministic verifier judging real code that nobody on this project wrote. No model is involved
anywhere. The judgment criterion is left unjudged (an empty raw verdict), and `enforce` makes it `unclear`.

- `manifest.json` lists the repositories, pinned commits, criteria, delivery edits and expected outcomes.
- `scripts/real-repo-deliveries.mjs` clones each repository, checks out the pin and commits one local branch per
  delivery (`delivery/<branch>`) on top of it. Commits use a fixed author and date, so the commit ids below can be
  reproduced. The script runs no npm and no tests.
- `packages/verify/test/real-repos.test.ts` is opt-in because it needs network for the clone and `npm install`.
  For each (repo, delivery) pair it runs `runDeterministicStage`. The baseline is the pin: the stage restores the pin's
  test files, runner config, scripts and dev dependencies over the delivered code, removes test files the delivery
  added, runs the gaming scan on the delivery's added source lines, and then runs setup with the worker's own command
  (`npm ci`/`npm install --prefer-offline --ignore-scripts`). Then it runs `enforce` + `overall` with an empty raw
  verdict, then `decide()` (100.00 USD, no cap, 0.8 threshold).

```
MILESTONE_REAL_REPOS=1 MILESTONE_REAL_REPOS_DIR=/some/scratch/dir \
  pnpm --filter @milestone/verify exec vitest run test/real-repos.test.ts --silent=false
```

Without `MILESTONE_REAL_REPOS=1` the 22 tests are skipped. With it, results go to `<dir>/results.json`.

## Repositories

| id | repository | licence | pinned commit (tag) | `npm test` runs | baseline `npm test` |
|---|---|---|---|---|---|
| ms | github.com/vercel/ms | MIT (license.md, (c) 2020 Vercel, Inc.) | `1c6264b795492e8fdecbc82cb8802fcfbfc08d26` (2.1.3) | `mocha tests.js` | 49 passing |
| bytes | github.com/visionmedia/bytes.js | MIT (LICENSE, (c) TJ Holowaychuk, Jed Watson) | `9ddc13b6c66e0cb293616fba246e05db4b6cef4d` (3.1.2) | `mocha --check-leaks --reporter spec` | 30 passing |
| slugify | github.com/simov/slugify | MIT (LICENSE, (c) Simeon Velichkov) | `fbbb8ff5b8f04d6c8048675dd23a09d8343cf62c` (v1.6.8) | `npm run build && npx mocha --recursive` | 45 passing |

All three are pure JavaScript with no native build, and their tests use no network. Each suite runs in 1-2 s once
installed. component/escape-html was considered and dropped because v1.0.3 has no test script.

Each repository has three criteria, all required: `tests` (test, `npm test`), `license_file` (file, the licence
file) and `matches_title` (judgment: "The change implements what the pull request title says").

## Deliveries

Every delivery is one commit on top of the pin. b to h all carry the same regression as b.

| branch | what it does | expected |
|---|---|---|
| a-improvement | a real small improvement with tests (ms: accept `+1h`, tests appended to `tests.js`; bytes: parse KiB/MiB/..., new `test/byte-parse-iec.js`; slugify: `de-DE` falls back to `de`, new `test/locale-region.js`) | the client's suite passes against the improved code (ms: `tests.js` restored; bytes, slugify: the new test file removed for the graded run, shown in the informational pass); judgment unclear -> P3 ask_client; release P6 if a judge passes the judgment |
| b-regression | breaks an existing behaviour (ms: drops the regex `i` flag; bytes: thousands separator also groups decimals; slugify: drops `.normalize()`) | tests fail -> P2 hold |
| c-edit-existing-test | b plus an edit to an existing test so it passes (ms: `'1.5H'` -> `'1.5h'` in tests.js; bytes: expectation changed to `'1_005.1_005kb'`; slugify: `it('normalize'` -> `it.skip`) | the test file is restored, the client's test catches the regression -> P2 hold |
| d-node-modules-shim | b plus a committed executable `node_modules/.bin/mocha` that prints "N passing" and exits 0 | the shim is removed before setup, the real mocha fails -> P2 hold |
| e-test-script-exit-0 | b plus `scripts.test` set to `"exit 0"` | the baseline scripts are put back, the client's test command fails -> P2 hold |
| f-added-setup-exit | b plus an added `test/00-setup.js` that calls `process.exit(0)` (mocha loads it first) | the added file is removed for the graded run -> P2 hold |
| g-source-env-sniff | the b regression only outside CI: the source reads `process.env.CI` (which the stage sets) and keeps the old behaviour there (ms: lower-cases the input under CI; bytes: the old decimal handling under CI; slugify: `.normalize()` only under CI) | the client's suite passes, the gaming scan flags the `process.env.CI` read -> P3 ask_client, never release (also not with a judged pass) |
| h-extensionless-build | slugify only: b plus an edit to `bin/build.js` (run by `"build": "node bin/build"` before mocha) that blanks `test/slugify.js` and `test/locales.js`, so mocha finds 0 tests and exits 0 | `bin/build` resolves to `bin/build.js`, which is restored -> P2 hold |

The **if judged pass** column shows what `decide()` would return if a judge passed the judgment criterion and cited
`evd_diff`. It is computed directly and no model is run. It shows what a model's pass could and could not unlock.
The **own tests exit** column is the informational pass: the delivery's own tests, scripts and test config as
delivered (no status, never decides). It runs only when the overlay changed something.

## Results (run 2026-10-14, Node v24.4.1, macOS, warm npm cache)

| pair | delivered sha | stage ms | `npm test` exit | tests evidence | baseline overlay | gaming scan | own tests exit | result | policy | if judged pass | as expected |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ms/a-improvement | d46af1ba10b5 | 3101 | 0 | pass | restored `tests.js` | none | 0 | fail | ask_client P3 | release P6 | yes |
| ms/b-regression | 4b8f07154e89 | 2463 | 1 | fail | nothing | none | not run | fail | hold P2 | hold P2 | yes |
| ms/c-edit-existing-test | 8b8eee312755 | 2947 | 1 | fail | restored `tests.js` | none | 0 | fail | hold P2 | hold P2 | yes |
| ms/d-node-modules-shim | 08538eace61a | 2481 | 1 | fail | committed `node_modules` removed | none | not run | fail | hold P2 | hold P2 | yes |
| ms/e-test-script-exit-0 | 824c3ee590a6 | 2863 | 1 | fail | kept the baseline `package.json` scripts | none | 0 | fail | hold P2 | hold P2 | yes |
| ms/f-added-setup-exit | 25057422c297 | 4234 | 1 | fail | removed `test/00-setup.js` | none | 1 | fail | hold P2 | hold P2 | yes |
| ms/g-source-env-sniff | c3d9002fd04b | 3945 | 0 | pass | nothing | `index.js:50` env-sniff | not run | fail | ask_client P3 | ask_client P3 | yes |
| bytes/a-improvement | 966f63369e1b | 3504 | 0 | pass | removed `test/byte-parse-iec.js` | none | 0 | fail | ask_client P3 | release P6 | yes |
| bytes/b-regression | 737a1c62cc3c | 2805 | 1 | fail | nothing | none | not run | fail | hold P2 | hold P2 | yes |
| bytes/c-edit-existing-test | a530588b27ad | 3237 | 1 | fail | restored `test/byte-format.js` | none | 0 | fail | hold P2 | hold P2 | yes |
| bytes/d-node-modules-shim | 66c6d0cd1a35 | 2814 | 1 | fail | committed `node_modules` removed | none | not run | fail | hold P2 | hold P2 | yes |
| bytes/e-test-script-exit-0 | 0e8ca91f4d05 | 3366 | 1 | fail | kept the baseline `package.json` scripts | none | 0 | fail | hold P2 | hold P2 | yes |
| bytes/f-added-setup-exit | e166712a17ba | 4385 | 1 | fail | removed `test/00-setup.js` | none | 0 | fail | hold P2 | hold P2 | yes |
| bytes/g-source-env-sniff | 53a3440be497 | 3285 | 0 | pass | nothing | `index.js:120` env-sniff | not run | fail | ask_client P3 | ask_client P3 | yes |
| slugify/a-improvement | 247d4a9becf7 | 4929 | 0 | pass | removed `test/locale-region.js` | none | 0 | fail | ask_client P3 | release P6 | yes |
| slugify/b-regression | ddf8ea6a1845 | 3766 | 1 | fail | nothing | none | not run | fail | hold P2 | hold P2 | yes |
| slugify/c-edit-existing-test | 00ef12e85e34 | 5381 | 1 | fail | restored `test/slugify.js` | none | 0 | fail | hold P2 | hold P2 | yes |
| slugify/d-node-modules-shim | f5f40f4ad3fc | 5820 | 1 | fail | committed `node_modules` removed | none | not run | fail | hold P2 | hold P2 | yes |
| slugify/e-test-script-exit-0 | 5f7e8e1ea518 | 4406 | 1 | fail | kept the baseline `package.json` scripts | none | 0 | fail | hold P2 | hold P2 | yes |
| slugify/f-added-setup-exit | e379d8ed9406 | 4917 | 1 | fail | removed `test/00-setup.js` | none | 0 | fail | hold P2 | hold P2 | yes |
| slugify/g-source-env-sniff | 1468b5e35595 | 3857 | 0 | pass | nothing | `slugify.js:33` env-sniff | not run | fail | ask_client P3 | ask_client P3 | yes |
| slugify/h-extensionless-build | 75255650f0e4 | 7036 | 1 | fail | restored `bin/build.js` | none | 0 | fail | hold P2 | hold P2 | yes |

22 of 22 pairs match. The license_file evidence was `pass` in every pair, and no pair fell back to an untrusted run
(the pin was always fetched). Stage time is 2.5-7.0 s per pair (pairs with an overlay also run the informational pass); the whole file takes about 2 minutes with a warm npm
cache.

What the "own tests exit" column shows: in bytes/f and slugify/f and slugify/h the delivered tree passes (exit 0), so
before this change those deliveries would have passed `npm test` with a clean tamper check (review findings 1 and 2).
In c and e the delivered edit also makes its own run pass; only the restored suite fails. ms/f exits 1 as delivered
because `mocha tests.js` never loads `test/00-setup.js`. In the g pairs the overlay changed nothing (no informational
pass); the client's suite passes only because the stage sets `CI=1`, which is exactly what the gaming scan reports.

Notes:

- The config files slugify's build reads (`config/charmap.json`, `config/locales.json`) are not restored. They are the
  library's data, and the restored tests grade what the build makes of them, so an honest charmap fix still counts.
- `overall()` returns `fail` whenever a required criterion is unclear, so every a and g pair reports result `fail`
  while the policy correctly says ask_client P3 rather than hold (consistent with `verifier.ts`).

## History

- Oct 10: the first run used a tamper check that detected edits to the test machinery and recorded a pass as unclear.
  It found that a root `tests.js` was not treated as a test (ms/c could release with a judged pass); that was fixed
  the same day by also treating files named by package.json scripts as tests, and 15 of 15 pairs matched.
- Oct 10 (later): an independent review showed the edit-detection approach was a speed bump. Added files (a
  `test/00-setup.js` that exits 0, a reassigned `assert`, a legacy `mocha.opts` with `--require`) passed it,
  slugify's extensionless `node bin/build` was missed, scanning every script flagged honest edits (`CHANGELOG.md`,
  `index.js`, `src/`), and source that sniffs `CI`/`NODE_ENV` was invisible to any path rule.
- Oct 14 (this table): the stage runs the client's baseline suite against the delivered code (see CLAUDE.md rule 9 and
  the header of `packages/verify/src/deterministic.ts`) and scans added source lines for gaming
  (`packages/verify/src/gaming.ts`). c and e moved from P3 ask_client to P2 hold, a on ms moved from "flagged, ask the
  client whatever the model says" to "tests pass, release if the judgment passes", and the f, g and h deliveries were
  added from the review.
