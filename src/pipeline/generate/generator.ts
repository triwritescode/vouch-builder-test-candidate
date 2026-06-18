import type { HandoverDraft, ReconciledState } from "../../types";
import type { ModelClient } from "../../lib/anthropic";
import type { TraceRecorder } from "../../lib/trace";
import { PipelineError } from "../../lib/errors";
import { handoverDraftSchema } from "../ingest/validator";
import { GENERATOR_SYSTEM, buildGeneratorUser } from "./promptBuilder";

const TOOL = {
  name: "emit_handover",
  description:
    "Emit the morning handover: a short narrative, ranked priority actions, and a still-open summary.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      narrative: {
        type: "string",
        description: "2-4 sentence executive summary, action-first.",
      },
      priorityActions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            rank: { type: "integer" },
            category: {
              type: "string",
              enum: [
                "safety",
                "compliance",
                "time_critical",
                "financial",
                "operational",
                "informational",
              ],
            },
            action: { type: "string", description: "Imperative — what to do." },
            context: { type: "string" },
            deadline: { type: "string" },
            citedEventIds: {
              type: "array",
              items: { type: "string" },
              description: "REQUIRED. Event ids that support this action.",
            },
          },
          required: ["rank", "category", "action", "context", "citedEventIds"],
        },
      },
      stillOpenSummary: { type: "string" },
    },
    required: ["narrative", "priorityActions", "stillOpenSummary"],
  },
} as const;

// prompt -> HandoverDraft (LLM, tool use, temp 0). Tool use guarantees the
// shape; we still validate with Zod before trusting it. No JSON-fence stripping.
export async function generateHandover(
  state: ReconciledState,
  deps: { model: ModelClient; trace: TraceRecorder },
): Promise<{ draft: HandoverDraft; modelVersion: string }> {
  const system = GENERATOR_SYSTEM;
  const user = buildGeneratorUser(state);

  const { input, modelVersion } = await deps.model.callTool<HandoverDraft>({
    system,
    user,
    tool: TOOL,
    maxTokens: 4096,
    stage: "generate",
  });

  deps.trace.recordExchange({
    stage: "generate",
    tool: TOOL.name,
    system,
    user,
    response: input,
    modelVersion,
    temperature: 0,
  });

  const parsed = handoverDraftSchema.safeParse(input);
  if (!parsed.success) {
    throw new PipelineError(
      `Generator returned an invalid draft: ${parsed.error.message}`,
      "INVALID_DRAFT",
      "generate",
      false,
    );
  }

  return { draft: parsed.data, modelVersion };
}
