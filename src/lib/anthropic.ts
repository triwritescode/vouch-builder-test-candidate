import Anthropic from "@anthropic-ai/sdk";
import { PipelineError, type PipelineStage } from "./errors";

export const DEFAULT_MODEL = process.env.VOUCH_MODEL ?? "claude-sonnet-4-6";

export interface ToolSpec {
  name: string;
  description: string;
  // JSON Schema for the tool input. The SDK guarantees the model's response
  // conforms, so we never parse JSON out of free text.
  input_schema: { type: "object"; [k: string]: unknown };
}

export interface ToolCallParams {
  system: string;
  user: string;
  tool: ToolSpec;
  maxTokens?: number;
  stage: PipelineStage;
}

export interface ToolCallResult<T> {
  input: T;
  modelVersion: string;
}

// Narrow interface the pipeline depends on. Tests inject a fake; production
// injects the real SDK-backed client. The pipeline never touches the SDK
// directly, which keeps every model call mockable and deterministic in tests.
export interface ModelClient {
  callTool<T>(params: ToolCallParams): Promise<ToolCallResult<T>>;
}

export function createAnthropicClient(apiKey: string): ModelClient {
  const client = new Anthropic({ apiKey });

  return {
    async callTool<T>(params: ToolCallParams): Promise<ToolCallResult<T>> {
      const { system, user, tool, maxTokens = 4096, stage } = params;

      const send = () =>
        client.messages.create({
          model: DEFAULT_MODEL,
          max_tokens: maxTokens,
          temperature: 0, // determinism — required for reproducible runs
          system,
          messages: [{ role: "user", content: user }],
          tools: [tool as Anthropic.Tool],
          // Force the model to answer through the tool — structured by
          // construction, no JSON-string parsing, no fence stripping.
          tool_choice: { type: "tool", name: tool.name },
        });

      let res;
      try {
        res = await send();
      } catch (err) {
        // One retry for transient errors (network / 5xx / overloaded).
        if (isTransient(err)) {
          res = await send().catch((e) => {
            throw new PipelineError(
              `Anthropic call failed after retry (${tool.name})`,
              "ANTHROPIC_ERROR",
              stage,
              false,
              e,
            );
          });
        } else {
          throw new PipelineError(
            `Anthropic call failed (${tool.name})`,
            "ANTHROPIC_ERROR",
            stage,
            false,
            err,
          );
        }
      }

      const block = res.content.find((b) => b.type === "tool_use");
      if (!block || block.type !== "tool_use") {
        throw new PipelineError(
          `Model returned no tool_use block (${tool.name})`,
          "NO_TOOL_USE",
          stage,
          false,
        );
      }

      return { input: block.input as T, modelVersion: res.model };
    },
  };
}

function isTransient(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    const s = err.status ?? 0;
    return s === 429 || s >= 500;
  }
  return false;
}
