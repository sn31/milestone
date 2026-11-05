// Server only. The console's one door to a model: packages/verify/src/llm.ts (CLAUDE.md: model calls go through
// llm.ts only), whose provider (Claude, when ANTHROPIC_API_KEY is set) runs each turn.
// getProvider and toolResultBlocks are not re-exported by @milestone/verify's index, so they are imported from the
// file itself. DESIGN: if @milestone/verify starts exporting them, import from the package instead.
export { getProvider, NOT_RUN_FINAL_TURN, toolResultBlocks } from "../../../../../packages/verify/src/llm.ts";
export { answerNowMessage } from "../../../../../packages/verify/src/providers/types.ts";
export type { Message, ToolResult, ToolDef, AnswerDef } from "../../../../../packages/verify/src/providers/types.ts";
export { isModelConfigured, currentModel, wrapUntrusted } from "@milestone/verify";
