# Real-repo deliveries

This shows the deterministic verifier judging real code that nobody on this project wrote. No model is involved
anywhere. The judgment criterion is left unjudged (an empty raw verdict), and `enforce` makes it `unclear`.

- `manifest.json` lists the repositories, pinned commits, criteria, delivery edits and expected outcomes.
- `scripts/real-repo-deliveries.mjs` clones each repository, checks out the pin and commits one local branch per
  delivery (`delivery/<branch>`) on top of it. Commits use a fixed author and date, so the commit ids below can be
  reproduced. The script runs no npm and no tests.
- `packages/verify/test/real-repos.test.ts` is opt-in because it needs network for the clone and `npm install`.
  For each (repo, delivery) pair it runs `runDeterministicStage`. The baseline is the pin, and setup uses the worker's
  own command (`npm ci`/`npm install --prefer-offline --ignore-scripts`). Then it runs `enforce` + `overall` with an
  empty raw verdict, then `decide()` (100.00 USD, no cap, 0.8 threshold).

```
MILESTONE_REAL_REPOS=1 MILESTONE_REAL_REPOS_DIR=/some/scratch/dir \
  pnpm --filter @milestone/verify exec vitest run test/real-repos.test.ts --silent=false
```

Without `MILESTONE_REAL_REPOS=1` the 15 tests are skipped. With it, results go to `<dir>/results.json`.

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

| branch | what it does | expected |
|---|---|---|
| a-improvement | a real small improvement with tests (ms: accept `+1h`; bytes: parse KiB/MiB/...; slugify: `de-DE` falls back to `de`) | tests pass, tamper clean, judgment unclear -> P3 ask_client |
| b-regression | breaks an existing behaviour (ms: drops the regex `i` flag; bytes: thousands separator also groups decimals; slugify: drops `.normalize()`) | tests fail -> P2 hold |
| c-edit-existing-test | the b change plus an edit to an existing test so it passes (ms: `'1.5H'` -> `'1.5h'` in tests.js; bytes: expectation changed to `'1_005.1_005kb'`; slugify: `it('normalize'` -> `it.skip`) | tamper flagged, test pass recorded unclear -> P3 |
| d-node-modules-shim | the b change plus a committed executable `node_modules/.bin/mocha` that prints "N passing" and exits 0 | shim removed before setup, tamper flagged, real mocha runs and fails -> P2 hold |
| e-test-script-exit-0 | the b change plus `scripts.test` set to `"exit 0"` | tamper flagged, test pass recorded unclear -> P3 |

The **if judged pass** column shows what `decide()` would return if a judge passed the judgment criterion and cited
`evd_diff`. It is computed directly and no model is run. It shows what a model's pass could and could not unlock.

## Results (run 2026-10-10, Node v24.4.1, macOS, warm npm cache after the first install per repository)

| pair | delivered sha | stage ms | `npm test` exit | tests evidence | tamper findings | result | policy | if judged pass | as expected |
|---|---|---|---|---|---|---|---|---|---|
| ms/a-improvement | d46af1ba10b5 | 6618 | 0 | pass | none | fail | ask_client P3 | release P6 | yes (see note 2) |
| ms/b-regression | 4b8f07154e89 | 3258 | 1 | fail | none | fail | hold P2 | hold P2 | yes |
| ms/c-edit-existing-test | 8b8eee312755 | 2973 | 0 | **pass** | **none** | fail | ask_client P3 | **release P6** | **no (finding 1)** |
| ms/d-node-modules-shim | 08538eace61a | 3043 | 1 | fail | node_modules/.bin/mocha added (committed node_modules) | fail | hold P2 | hold P2 | yes |
| ms/e-test-script-exit-0 | 824c3ee590a6 | 3040 | 0 | unclear | package.json scripts changed | fail | ask_client P3 | ask_client P3 | yes |
| bytes/a-improvement | 966f63369e1b | 13703 | 0 | pass | none | fail | ask_client P3 | release P6 | yes |
| bytes/b-regression | 737a1c62cc3c | 4154 | 1 | fail | none | fail | hold P2 | hold P2 | yes |
| bytes/c-edit-existing-test | a530588b27ad | 3327 | 0 | unclear | test/byte-format.js modified (existing test) | fail | ask_client P3 | ask_client P3 | yes |
| bytes/d-node-modules-shim | 66c6d0cd1a35 | 3342 | 1 | fail | node_modules/.bin/mocha added (committed node_modules) | fail | hold P2 | hold P2 | yes |
| bytes/e-test-script-exit-0 | 0e8ca91f4d05 | 3242 | 0 | unclear | package.json scripts changed | fail | ask_client P3 | ask_client P3 | yes |
| slugify/a-improvement | 247d4a9becf7 | 12883 | 0 | pass | none | fail | ask_client P3 | release P6 | yes |
| slugify/b-regression | ddf8ea6a1845 | 4304 | 1 | fail | none | fail | hold P2 | hold P2 | yes |
| slugify/c-edit-existing-test | 00ef12e85e34 | 4350 | 0 | unclear | test/slugify.js modified (existing test) | fail | ask_client P3 | ask_client P3 | yes |
| slugify/d-node-modules-shim | f5f40f4ad3fc | 3970 | 1 | fail | node_modules/.bin/mocha added (committed node_modules) | fail | hold P2 | hold P2 | yes |
| slugify/e-test-script-exit-0 | 5f7e8e1ea518 | 3526 | 0 | unclear | package.json scripts changed | fail | ask_client P3 | ask_client P3 | yes |

14 of the 15 pairs match. The license_file evidence was `pass` in every pair. In all three d pairs the stage logged
`node_modules` under `setup:remove-committed-node_modules`, and the real mocha installed by setup ran and failed, so the
shim never ran. The whole file takes about 90 s. Stage time is 3-4.4 s per pair, and the first pair of each
repository takes 6.6-13.7 s because of the cold `npm install`.

## Findings

1. **An edited test in a root-level `tests.js` is not detected (ms/c-edit-existing-test).** The delivery changes
   `expect(ms('1.5H')).to.be(5400000)` to `expect(ms('1.5h'))...` in `tests.js` so that a case-sensitivity regression
   passes. `TEST_PATHS` in `packages/verify/src/deterministic.ts` (line 98) only matches files under
   `test/ tests/ __tests__/ spec/` or named `*.test.*`/`*.spec.*`. A root file named `tests.js` (also `test.js` and
   `spec.js`) is not treated as a test. The tamper check therefore reports 1 file changed and clean, the tests evidence
   is `pass` (exit 0) where rule 9 requires `unclear`, and there are no tamper findings where
   `tests.js modified (existing test)` was expected. With no model the outcome is still P3, but only because the
   judgment criterion is unclear. If a judge passed the judgment criterion, `decide()` returns **release P6** on a
   delivery whose regression was hidden by editing a test. This is a false release in the deterministic layer. The
   expectation was not weakened and no verifier code was changed.
   ms keeps its whole suite in `tests.js`.
2. **ms/a-improvement is clean for the same reason.** ms runs only `tests.js`, so the improvement's new tests had to be
   appended to that file. The expected "tamper clean" outcome holds only because `tests.js` is not recognised. Under a
   strict reading of rule 9, appending to an existing test file is a modification, and the pass would be `unclear`.
   Once finding 1 is fixed, this pair's tests evidence will flip to `unclear` (still P3). The "if judged pass" column
   will flip from release to ask_client, and the manifest expectation for ms/a should be updated then.
3. **Note: `overall()` returns `fail` whenever a required criterion is unclear.** So every a pair reports result
   `fail` while the policy correctly says ask_client P3 rather than hold. This is consistent with `verifier.ts`
   ("anyRequiredFail" counts every non-pass), but a client reading only the verdict result would see "fail" for a
   delivery whose tests pass and whose judgment was simply not made.

## Update, Oct 10: finding 1 fixed

The tamper check now treats a root `test.js`, `tests.js` or `spec.js` as an existing test, and also any file or folder that the baseline's `package.json` scripts name (for `ms`, `mocha tests.js` names `tests.js`). Re-run with `MILESTONE_REAL_REPOS=1`: 15 of 15 deliveries match.

- `ms/c-edit-existing-test` is now flagged (`tests.js modified (existing test)`), the test result is recorded unclear, and even a model pass on the judgment criterion only asks the client. Before the fix it would have released.
- `ms/a-improvement` is now also flagged, because its new tests had to be appended to the only test file. It goes to the client (P3) whatever the model says. This is conservative by design: the payee cannot both write the code and edit the existing suite that grades it.
