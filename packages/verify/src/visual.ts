import type { CriterionSpec, EvidenceSummary } from "@milestone/core";

/** Planned: a cloud browser driven with Playwright; screenshots and the session replay become evidence. */
export async function runVisualStage(_input: { deployUrl: string; criteria: CriterionSpec[] }): Promise<EvidenceSummary[]> {
  throw new Error("visual stage not implemented yet");
}
