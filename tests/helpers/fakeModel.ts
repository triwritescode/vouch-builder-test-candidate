import type { ModelClient, ToolCallParams } from "@/lib/anthropic";

type Responder = (params: ToolCallParams) => unknown;

// A deterministic, offline ModelClient for tests. Map each tool name to the
// tool input it should return; the pipeline never touches the real SDK.
export function fakeModel(responders: Record<string, Responder | unknown>): ModelClient {
  return {
    async callTool<T>(params: ToolCallParams) {
      const r = responders[params.tool.name];
      if (r === undefined) {
        throw new Error(`fakeModel: no responder for tool ${params.tool.name}`);
      }
      const input = typeof r === "function" ? (r as Responder)(params) : r;
      return { input: input as T, modelVersion: "fake-model-1" };
    },
  };
}

// A model that always throws — to exercise recoverable fallbacks.
export function throwingModel(): ModelClient {
  return {
    async callTool<T>(): Promise<{ input: T; modelVersion: string }> {
      throw new Error("model unavailable");
    },
  };
}
