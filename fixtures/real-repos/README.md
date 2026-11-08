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

Without `MILESTONE_REAL_REPOS=1` the 29 tests are skipped. With it, results go to `<dir>/results.json`.

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

Every delivery is one commit on top of the pin. b to k all carry the same regression as b (i guards it behind a
runner sniff; j and k hide it behind a neutered assertion library).

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
| i-argv-sniff | red-team attack 1 (ms, bytes, slugify): the b regression applies only when `process.argv` does **not** name mocha, so the client's suite (run under mocha) passes while real callers get the broken code (ms: the case-sensitive regex; bytes: the whole-string grouping; slugify: no `.normalize()`) | the client's suite passes, the gaming scan's `test-detect` rule flags `process.argv` matched against a runner name -> P3 ask_client, never release (also not with a judged pass) |
| j-assertion-patch | red-team attack 2 (ms, bytes, slugify): the b regression plus a require-time patch of the assertion library the client's tests use, so every assertion passes (ms: `require('expect.js').Assertion.prototype.assert` neutered; bytes, slugify: an aliased `require('assert')` whose methods are overwritten) | the client's suite passes, the gaming scan's `assert-patch` rule flags the write to the assertion library -> P3 ask_client, never release (also not with a judged pass) |
| k-new-dependency | red-team attack 4 (ms only): adds a NEW `dependencies` entry `ms-compat` as a `file:` path to a folder committed under `vendor/`; `ms-compat` neuters `expect.js` at require time, so the dropped-`i`-flag regression passes. Because it cannot be published, it is a local `file:` dependency | the manifest merge keeps the entry and setup installs it, so its unreviewed code runs with the client's tests; the **dependency rule** records it as unclear on the test criterion (both because the name is new and because the source is `file:`) -> P3 ask_client, never release, **even if a judge passes the judgment**. Because the folder is committed, the gaming scan also flags `vendor/ms-compat/index.js`; a dependency fetched from a registry would not be scanned, which is why the dependency rule (a policy rule, not detection) is the one that generalizes |

The **if judged pass** column shows what `decide()` would return if a judge passed the judgment criterion and cited
`evd_diff`. It is computed directly and no model is run. It shows what a model's pass could and could not unlock.
The **own tests exit** column is the informational pass: the delivery's own tests, scripts and test config as
delivered (no status, never decides). It runs only when the overlay changed something.

## Results (run 2026-10-14, Node v24.4.1, macOS, warm npm cache; 29 pairs)

| pair | delivered sha | stage ms | `npm test` exit | tests evidence | baseline overlay | gaming scan | own tests exit | result | policy | if judged pass | as expected |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ms/a-improvement | d46af1ba10b5 | 3506 | 0 | pass | restored `tests.js` | none | 0 | fail | ask_client P3 | release P6 | yes |
| ms/b-regression | 4b8f07154e89 | 2599 | 1 | fail | nothing | none | not run | fail | hold P2 | hold P2 | yes |
| ms/c-edit-existing-test | 8b8eee312755 | 3060 | 1 | fail | restored `tests.js` | none | 0 | fail | hold P2 | hold P2 | yes |
| ms/d-node-modules-shim | 08538eace61a | 2695 | 1 | fail | committed `node_modules` removed | none | not run | fail | hold P2 | hold P2 | yes |
| ms/e-test-script-exit-0 | 824c3ee590a6 | 2924 | 1 | fail | kept the baseline `package.json` scripts | none | 0 | fail | hold P2 | hold P2 | yes |
| ms/f-added-setup-exit | 25057422c297 | 4262 | 1 | fail | removed `test/00-setup.js` | none | 1 | fail | hold P2 | hold P2 | yes |
| ms/g-source-env-sniff | c3d9002fd04b | 3979 | 0 | pass | nothing | `index.js:50` env-sniff | not run | fail | ask_client P3 | ask_client P3 | yes |
| ms/i-argv-sniff | 2925f0196b5e | 2639 | 0 | pass | nothing | `index.js:53` test-detect | not run | fail | ask_client P3 | ask_client P3 | yes |
| ms/j-assertion-patch | 9b1e1d496537 | 2570 | 0 | pass | nothing | `index.js:7` assert-patch | not run | fail | ask_client P3 | ask_client P3 | yes |
| ms/k-new-dependency | 23944c17d6d7 | 3241 | 0 | pass | dropped `package-lock.json`; installed `ms-compat@file:vendor/ms-compat` (unreviewed) | `vendor/ms-compat/index.js:4` assert-patch; dependency rule: new `file:` dep `ms-compat` | 0 | fail | ask_client P3 | ask_client P3 | yes |
| bytes/a-improvement | 966f63369e1b | 3258 | 0 | pass | removed `test/byte-parse-iec.js` | none | 0 | fail | ask_client P3 | release P6 | yes |
| bytes/b-regression | 737a1c62cc3c | 3545 | 1 | fail | nothing | none | not run | fail | hold P2 | hold P2 | yes |
| bytes/c-edit-existing-test | a530588b27ad | 4272 | 1 | fail | restored `test/byte-format.js` | none | 0 | fail | hold P2 | hold P2 | yes |
| bytes/d-node-modules-shim | 66c6d0cd1a35 | 3404 | 1 | fail | committed `node_modules` removed | none | not run | fail | hold P2 | hold P2 | yes |
| bytes/e-test-script-exit-0 | 0e8ca91f4d05 | 3242 | 1 | fail | kept the baseline `package.json` scripts | none | 0 | fail | hold P2 | hold P2 | yes |
| bytes/f-added-setup-exit | e166712a17ba | 3284 | 1 | fail | removed `test/00-setup.js` | none | 0 | fail | hold P2 | hold P2 | yes |
| bytes/g-source-env-sniff | 53a3440be497 | 2808 | 0 | pass | nothing | `index.js:120` env-sniff | not run | fail | ask_client P3 | ask_client P3 | yes |
| bytes/i-argv-sniff | 01a5a5173cf8 | 2814 | 0 | pass | nothing | `index.js:120` test-detect | not run | fail | ask_client P3 | ask_client P3 | yes |
| bytes/j-assertion-patch | 681c561972d7 | 3672 | 0 | pass | nothing | `index.js:11` assert-patch | not run | fail | ask_client P3 | ask_client P3 | yes |
| slugify/a-improvement | 247d4a9becf7 | 7138 | 0 | pass | removed `test/locale-region.js` | none | 0 | fail | ask_client P3 | release P6 | yes |
| slugify/b-regression | ddf8ea6a1845 | 4068 | 1 | fail | nothing | none | not run | fail | hold P2 | hold P2 | yes |
| slugify/c-edit-existing-test | 00ef12e85e34 | 5052 | 1 | fail | restored `test/slugify.js` | none | 0 | fail | hold P2 | hold P2 | yes |
| slugify/d-node-modules-shim | f5f40f4ad3fc | 5054 | 1 | fail | committed `node_modules` removed | none | not run | fail | hold P2 | hold P2 | yes |
| slugify/e-test-script-exit-0 | 5f7e8e1ea518 | 6081 | 1 | fail | kept the baseline `package.json` scripts | none | 0 | fail | hold P2 | hold P2 | yes |
| slugify/f-added-setup-exit | e379d8ed9406 | 5274 | 1 | fail | removed `test/00-setup.js` | none | 0 | fail | hold P2 | hold P2 | yes |
| slugify/g-source-env-sniff | 1468b5e35595 | 3932 | 0 | pass | nothing | `slugify.js:33` env-sniff | not run | fail | ask_client P3 | ask_client P3 | yes |
| slugify/h-extensionless-build | 75255650f0e4 | 5236 | 1 | fail | restored `bin/build.js` | none | 0 | fail | hold P2 | hold P2 | yes |
| slugify/i-argv-sniff | 498799eee8bc | 5301 | 0 | pass | nothing | `slugify.js:33` test-detect | not run | fail | ask_client P3 | ask_client P3 | yes |
| slugify/j-assertion-patch | 7402afba044f | 4256 | 0 | pass | nothing | `slugify.js:17` assert-patch | not run | fail | ask_client P3 | ask_client P3 | yes |

29 of 29 pairs match. The license_file evidence was `pass` in every pair, and no pair fell back to an untrusted run
(the pin was always fetched). Stage time is 2.5-7.1 s per pair (pairs with an overlay also run the informational pass); the whole file takes about 2.5 minutes with a warm
npm cache.

What the "own tests exit" column shows: in bytes/f and slugify/f and slugify/h the delivered tree passes (exit 0), so
before this change those deliveries would have passed `npm test` with a clean tamper check.
In c and e the delivered edit also makes its own run pass; only the restored suite fails. ms/f exits 1 as delivered
because `mocha tests.js` never loads `test/00-setup.js`. In the g, i and j pairs the overlay changed nothing (no informational
pass); the client's suite passes because the delivered source reacts to the test run (g reads `process.env.CI`; i matches
`process.argv` against `mocha`; j neuters the assertion library), which is exactly what the gaming scan reports. ms/k
does run the informational pass (exit 0) because the overlay dropped the lockfile to install the new `file:` dependency.

Notes:

- The config files slugify's build reads (`config/charmap.json`, `config/locales.json`) are not restored. They are the
  library's data, and the restored tests grade what the build makes of them, so an honest charmap fix still counts.
- `overall()` returns `fail` whenever a required criterion is unclear, so every a, g, i, j and k pair reports result
  `fail` while the policy correctly says ask_client P3 rather than hold (consistent with `verifier.ts`).
- ms/k models red-team attack 4: a published dependency cannot be added here, so the malicious helper is a local
  `file:` dependency committed under `vendor/`. The dependency rule flags it twice over (a new name, and a `file:`
  source), so it reaches the client even if a judge passes the judgment. Because the folder is committed the gaming
  scan also catches `vendor/ms-compat/index.js`; a registry dependency's source would not be scanned at all, which is
  what makes the dependency rule (policy, not detection) the general defence.

## Why the stage works this way

- **Edit detection was not enough.** An earlier stage detected edits to the test machinery and recorded a pass as
  unclear. Added files (a `test/00-setup.js` that exits 0, a reassigned `assert`, a legacy `mocha.opts` with
  `--require`) passed it, slugify's extensionless `node bin/build` was missed, scanning every script flagged honest
  edits (`CHANGELOG.md`, `index.js`, `src/`), and source that sniffs `CI`/`NODE_ENV` was invisible to any path rule.
- **So the client's baseline suite grades the delivery.** The stage runs the client's baseline suite against the
  delivered code (CLAUDE.md rule 9 and the header of `packages/verify/src/deterministic.ts`) and scans added source
  lines for gaming (`packages/verify/src/gaming.ts`). Files named by package.json scripts count as tests, which is
  what catches a root `tests.js` like ms's.
- **Three adversarial deliveries test the limits.** i (`test-detect`) notices the test run through
  `process.argv`/`require.main`/`process.mainModule`/`module.parent`/a stack trace rather than an env var; j
  (`assert-patch`) neuters the assertion library the client's tests use, in every listed form (an aliased
  `require('assert')`, a non-`assert` library like `expect.js`, `Object.prototype`/`Reflect.defineProperty` writes,
  computed global/process keys); k adds a new `file:` dependency whose unreviewed code runs with the client's tests.
  The gaming scan covers i and j and an obfuscated computed `process[k](0)` exit; a policy rule in `deterministic.ts`
  (`mergeManifest`/`dependencyEvidence`) sends a delivery that adds or re-points a dependency to the client (P3) even
  when the suite passes. All 29 pairs match; i and j reach P3 by the scan, k by the dependency rule, and none of these
  deliveries can release even with a judged pass.

## The scan is a tripwire, not a guarantee

A follow-up red team tried nine new variations of the three attack classes on `vercel/ms`. Four were caught (an assertion patch through a loop over the prototype, an npm alias dependency, `overrides` pointing at a vendored fake, a lockfile re-pointing a test dependency). Five would release if a judge passed the judgment criterion: runner detection through test globals (`typeof describe === 'function'`), through `require.cache`, or through a signal read in another file, and assertion patching through `Object.assign` on an alias or a `require` called under another name.

These are the limit of a line-based scan of code that runs in the same process as the tests. The protections that do not depend on the scan are the review window with the client's veto, per-release caps, one payout attempt per milestone, and the dispute path. A container per verification with a trusted test harness outside the payee's process is the production fix.
