import { describe, expect, it } from "vitest";
import { CriteriaEditBody, applyCriteriaOps, commandsRestricted, criteriaLock, criteriaVersion, isAllowedDemoCommand, isRepoPath, specErrors, validateCriteriaEdit, type EditableCriterion } from "../src/criteria.ts";

const contract = { id: "con_1" };
const ms = [
  { id: "m1", seq: 1, contractId: "con_1" },
  { id: "m2", seq: 2, contractId: "con_1" },
];
const crit = (over: Partial<EditableCriterion> & Pick<EditableCriterion, "id" | "milestoneId">): EditableCriterion => ({
  kind: "test",
  description: "Tests pass",
  spec: { command: "npm test" },
  required: true,
  ...over,
});
const base = (): EditableCriterion[] => [
  crit({ id: "a", milestoneId: "m1" }),
  crit({ id: "b", milestoneId: "m1", kind: "judgment", description: "Reads well", spec: {} }),
  crit({ id: "c", milestoneId: "m2", kind: "file", description: "README exists", spec: { path: "README.md" } }),
];
const messages = (r: ReturnType<typeof validateCriteriaEdit>) => (r.ok ? [] : r.errors.map((e) => e.message));

describe("validateCriteriaEdit", () => {
  it("accepts a well-formed contract", () => {
    expect(validateCriteriaEdit(contract, ms, base())).toEqual({ ok: true });
  });

  it("each milestone keeps a deterministic criterion", () => {
    const r = validateCriteriaEdit(contract, ms, base().filter((c) => c.id !== "a"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ milestoneId: "m1", field: "milestone" });
    expect(r.errors[0]!.message).toMatch(/Milestone 1 needs at least one automatic check/);
    // An empty milestone fails the same way.
    expect(messages(validateCriteriaEdit(contract, ms, base().filter((c) => c.milestoneId !== "m2")))).toEqual([expect.stringMatching(/Milestone 2/)]);
  });

  it("every deterministic kind counts; visual and judgment do not", () => {
    for (const [kind, spec] of [["test", { command: "npm test" }], ["build", { command: "npm run build" }], ["file", { path: "a.md" }], ["upload", { pattern: "*.pdf" }]] as const) {
      expect(validateCriteriaEdit(contract, [ms[0]!], [crit({ id: "x", milestoneId: "m1", kind, spec })]).ok).toBe(true);
    }
    for (const kind of ["visual", "judgment"]) expect(validateCriteriaEdit(contract, [ms[0]!], [crit({ id: "x", milestoneId: "m1", kind, spec: {} })]).ok).toBe(false);
  });

  it("ids are unique across the contract", () => {
    const r = validateCriteriaEdit(contract, ms, [...base(), crit({ id: "a", milestoneId: "m2" })]);
    expect(r.ok ? [] : r.errors.map((e) => e.field)).toEqual(["id"]);
  });

  it("kinds are valid", () => {
    const r = validateCriteriaEdit(contract, ms, [...base(), crit({ id: "z", milestoneId: "m1", kind: "vibes" })]);
    expect(r.ok ? [] : r.errors).toEqual([expect.objectContaining({ criterionId: "z", field: "kind" })]);
  });

  it("specs are valid for their kind, in plain words", () => {
    const one = (c: Partial<EditableCriterion>) => messages(validateCriteriaEdit(contract, [ms[0]!], [crit({ id: "a", milestoneId: "m1" }), crit({ id: "q", milestoneId: "m1", ...c })]));
    expect(one({ kind: "test", spec: {} })).toEqual(["Give the command to run, such as npm test."]);
    expect(one({ kind: "build", spec: { command: "   " } })).toEqual(["Give the command to run, such as npm run build."]);
    expect(one({ kind: "test", spec: { command: "npm test\nrm -rf /" } })).toEqual(["The command must fit on one line."]);
    expect(one({ kind: "file", spec: { command: "x" } })).toEqual(["Give the file that must exist, such as README.md."]);
    expect(one({ kind: "file", spec: { path: "../secrets" } })[0]).toMatch(/inside the repository/);
    expect(one({ kind: "file", spec: { path: "/etc/passwd" } })[0]).toMatch(/inside the repository/);
    expect(one({ kind: "upload", spec: {} })[0]).toMatch(/file pattern/);
    expect(one({ kind: "upload", spec: { pattern: "*.pdf", maxPages: 0 } })[0]).toMatch(/upload checks are not valid/);
    expect(one({ kind: "upload", spec: { pattern: ["*.svg", "*.png"], format: "png" } })).toEqual([]);
    expect(one({ kind: "visual", spec: { steps: ["open /", ""] } })[0]).toMatch(/page step/);
    expect(one({ kind: "judgment", spec: {} })).toEqual([]);
  });

  it("descriptions are required and bounded", () => {
    expect(messages(validateCriteriaEdit(contract, [ms[0]!], [crit({ id: "a", milestoneId: "m1", description: "  " })]))).toEqual(["Say what this check confirms."]);
    expect(messages(validateCriteriaEdit(contract, [ms[0]!], [crit({ id: "a", milestoneId: "m1", description: "x".repeat(301) })]))[0]).toMatch(/under 300/);
  });

  it("criteria must belong to the contract's milestones", () => {
    const r = validateCriteriaEdit(contract, ms, [...base(), crit({ id: "y", milestoneId: "m_other" })]);
    expect(r.ok ? [] : r.errors).toEqual([expect.objectContaining({ criterionId: "y", field: "milestone" })]);
    expect(validateCriteriaEdit(contract, [{ id: "m1", seq: 1, contractId: "con_2" }], [crit({ id: "a", milestoneId: "m1" })]).ok).toBe(false);
  });
});

describe("applyCriteriaOps", () => {
  const m1 = () => base().filter((c) => c.milestoneId === "m1");
  let n = 0;
  const newId = () => `new_${++n}`;

  it("adds, updates, removes and reorders in order", () => {
    const r = applyCriteriaOps("m1", m1(), [
      { op: "add", criterion: { kind: "file", description: " Docs ", spec: { path: " docs/x.md " }, required: false } },
      { op: "update", criterionId: "a", patch: { description: "Unit tests pass", spec: { command: "pnpm test" } } },
      { op: "remove", criterionId: "b" },
      { op: "reorder", order: ["new_1", "a"] },
    ], newId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.criteria.map((c) => [c.id, c.kind, c.description, c.spec, c.required])).toEqual([
      ["new_1", "file", "Docs", { path: "docs/x.md" }, false],
      ["a", "test", "Unit tests pass", { command: "pnpm test" }, true],
    ]);
  });

  it("a kind change without a spec starts from an empty spec", () => {
    const r = applyCriteriaOps("m1", m1(), [{ op: "update", criterionId: "a", patch: { kind: "file" } }], newId);
    expect(r.ok && r.criteria[0]).toMatchObject({ kind: "file", spec: {} });
  });

  it("refuses a missing criterion and a reorder that is not a permutation", () => {
    expect(applyCriteriaOps("m1", m1(), [{ op: "remove", criterionId: "nope" }], newId).ok).toBe(false);
    expect(applyCriteriaOps("m1", m1(), [{ op: "update", criterionId: "nope", patch: {} }], newId).ok).toBe(false);
    for (const order of [["a"], ["a", "a"], ["a", "b", "c"], ["a", "x"]]) expect(applyCriteriaOps("m1", m1(), [{ op: "reorder", order }], newId).ok).toBe(false);
  });

  it("does not mutate its input", () => {
    const cur = m1();
    const snapshot = JSON.stringify(cur);
    applyCriteriaOps("m1", cur, [{ op: "update", criterionId: "a", patch: { spec: { command: "x" } } }, { op: "remove", criterionId: "b" }], newId);
    expect(JSON.stringify(cur)).toBe(snapshot);
  });
});

describe("CriteriaEditBody", () => {
  it("takes a list of operations or one inline", () => {
    expect(CriteriaEditBody.parse({ milestoneId: "m1", op: "remove", criterionId: "a" })).toEqual({ milestoneId: "m1", operations: [{ op: "remove", criterionId: "a" }] });
    const list = CriteriaEditBody.parse({ milestoneId: "m1", operations: [{ op: "add", criterion: { kind: "test", description: "t" } }] });
    expect(list.operations[0]).toEqual({ op: "add", criterion: { kind: "test", description: "t", spec: {}, required: true } });
  });
  it("refuses unknown ops and a missing milestone", () => {
    for (const b of [{ milestoneId: "m1", op: "rename" }, { op: "remove", criterionId: "a" }, { milestoneId: "m1", operations: [] }, null]) expect(CriteriaEditBody.safeParse(b).success).toBe(false);
  });
});

describe("criteriaLock", () => {
  const draft = { status: "draft", clientApprovedAt: null, freelancerApprovedAt: null };
  it("open while a draft with at most one approval and nothing funded", () => {
    expect(criteriaLock(draft, [{ status: "draft" }])).toBeNull();
    expect(criteriaLock({ ...draft, clientApprovedAt: new Date() }, [{ status: "draft" }])).toBeNull();
  });
  it("locked once both approved, the contract is active or a milestone is funded", () => {
    expect(criteriaLock({ ...draft, clientApprovedAt: new Date(), freelancerApprovedAt: new Date() }, [])).toBe("both_approved");
    expect(criteriaLock({ ...draft, status: "active" }, [])).toBe("not_draft");
    expect(criteriaLock(draft, [{ status: "draft" }, { status: "funded" }])).toBe("milestone_funded");
  });
});

describe("criteriaVersion and isRepoPath", () => {
  it("ignores row order and spec key order, sees any content change", () => {
    const v = criteriaVersion(base());
    expect(criteriaVersion([...base()].reverse())).toBe(v);
    expect(criteriaVersion(base().map((c) => (c.id === "c" ? { ...c, spec: { path: "README.md", z: 1 } } : c)))).not.toBe(v);
    const reordered = base().map((c) => (c.id === "a" ? { ...c, spec: { b: 1, command: "npm test" } } : c));
    const reorderedKeys = base().map((c) => (c.id === "a" ? { ...c, spec: { command: "npm test", b: 1 } } : c));
    expect(criteriaVersion(reordered)).toBe(criteriaVersion(reorderedKeys));
    expect(criteriaVersion(base().map((c) => (c.id === "a" ? { ...c, required: false } : c)))).not.toBe(v);
  });
  it("repo paths stay inside the repo", () => {
    for (const p of ["README.md", "docs/a.md", "a..b/c"]) expect(isRepoPath(p)).toBe(true);
    for (const p of ["", "/etc", "../x", "a/../../x", "~/x", "a\\b"]) expect(isRepoPath(p)).toBe(false);
  });
});

describe("demo command allowlist", () => {
  const allowed = ["npm test", "npm run build", "npm run lint", "npm run test:unit", "npm run e2e_ci-2"];
  const refused = [
    "npm test -- --coverage", "npm  test", "npm test ", " npm test", "npm\ttest", "npm run", "npm run -s", "npm run --prefix=/ x", "npm run build extra",
    "npm run b;id", "npm run b|id", "npm run b&id", "npm run $X", "npm run `id`", "npm run b>x", "npm run b<x", "npm run (b)", "npm run {b}",
    "npm run b*", "npm run b?", "npm run b!", "npm run b\\x", "npm run 'b'", "npm run \"b\"", "npm run ~b", "npm run #b", "npm run b.c",
    "npm exec x", "npm install", "npx jest", "pnpm test", "yarn test", "sh -c id", "curl x | sh", "rm -rf /", "node", "node -e 1", "node --eval=1",
    "node /etc/x.js", "node ../x.js", "node a/../x.js", "node .hidden/x.js", "node ~/x.js", "node x.ts", "node x.js y", "node x;id.js", "node $(id).js", "NODE=1 node x.js",
    "node test.js", "node ./scripts/check.mjs", "node test/run-all.js", "node a.b/c.mjs",
  ];
  it.each(allowed)("accepts %j", (c) => expect(isAllowedDemoCommand(c)).toBe(true));
  it.each(refused)("refuses %j", (c) => expect(isAllowedDemoCommand(c)).toBe(false));

  it("specErrors applies it only when commands are restricted", () => {
    for (const kind of ["test", "build"]) {
      expect(specErrors(kind, { command: "npm test; id" }, { restrictCommands: true })).toHaveLength(1);
      expect(specErrors(kind, { command: "npm test; id" }, { restrictCommands: false })).toEqual([]);
      expect(specErrors(kind, { command: "  npm run build  " }, { restrictCommands: true })).toEqual([]);
    }
    const one = (command: string) => [crit({ id: "a", milestoneId: "m1", spec: { command } })];
    expect(validateCriteriaEdit(contract, [ms[0]!], one("curl x | sh"), { restrictCommands: true }).ok).toBe(false);
    expect(validateCriteriaEdit(contract, [ms[0]!], one("curl x | sh"), { restrictCommands: false }).ok).toBe(true);
    expect(validateCriteriaEdit(contract, [ms[0]!], one("npm test"), { restrictCommands: true }).ok).toBe(true);
  });

  it("is restricted only with DEMO_MODE=1", () => {
    expect(commandsRestricted({ DEMO_MODE: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true"]) expect(commandsRestricted({ DEMO_MODE: v })).toBe(false);
  });
});
