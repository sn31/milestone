import { z } from "zod";
import { generateJson, wrapUntrusted } from "./llm.js";

/** The model only explains numbers it is handed (advance offers, policy decisions); it never computes them. */
export async function explain(kind: "advance_offer" | "policy_decision", numbers: Record<string, unknown>, audience: "freelancer" | "client"): Promise<string> {
  const res = await generateJson({
    system: `Write two plain-English sentences for a ${audience} explaining this ${kind.replace("_", " ")}. Use the numbers exactly as given, name the main reason, no hedging, no marketing.`,
    user: wrapUntrusted(JSON.stringify(numbers, null, 2), "numbers"),
    schema: z.object({ text: z.string().max(400) }),
    schemaName: "explanation",
    maxTokens: 300,
  });
  return res.ok ? res.value.text : "Explanation unavailable.";
}
