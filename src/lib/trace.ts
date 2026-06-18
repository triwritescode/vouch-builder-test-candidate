import type { ReconciledState, VerificationResult } from "../types";

// A replayable trace: with temperature pinned to 0 and the full prompt/response
// stored, any builder can re-run the exact inputs and reproduce a bad handover.
export interface LlmExchange {
  stage: string;
  tool: string;
  system: string;
  user: string;
  response: unknown;
  modelVersion: string;
  temperature: 0;
}

export interface RunTrace {
  runId: string;
  hotelId: string;
  shiftDate: string;
  startedAt: string;
  exchanges: LlmExchange[];
  reconciledState?: ReconciledState;
  verification?: VerificationResult;
}

export interface TraceRecorder {
  recordExchange(ex: LlmExchange): void;
  recordReconciledState(state: ReconciledState): void;
  recordVerification(v: VerificationResult): void;
  snapshot(): RunTrace;
}

export function createTraceRecorder(
  runId: string,
  hotelId: string,
  shiftDate: string,
): TraceRecorder {
  const trace: RunTrace = {
    runId,
    hotelId,
    shiftDate,
    startedAt: new Date().toISOString(),
    exchanges: [],
  };
  return {
    recordExchange: (ex) => trace.exchanges.push(ex),
    recordReconciledState: (state) => {
      trace.reconciledState = state;
    },
    recordVerification: (v) => {
      trace.verification = v;
    },
    snapshot: () => trace,
  };
}

// A no-op recorder for tests.
export function nullTraceRecorder(): TraceRecorder {
  return {
    recordExchange: () => {},
    recordReconciledState: () => {},
    recordVerification: () => {},
    snapshot: () => ({
      runId: "test",
      hotelId: "test",
      shiftDate: "test",
      startedAt: new Date().toISOString(),
      exchanges: [],
    }),
  };
}

// In-memory trace store (swappable, same rationale as RunStore). Pinned to
// globalThis so all route bundles share one map (see store.ts).
const g = globalThis as typeof globalThis & {
  __vouchTraces?: Map<string, RunTrace>;
};
const traces = (g.__vouchTraces ??= new Map<string, RunTrace>());
export const traceStore = {
  put: (t: RunTrace) => traces.set(t.runId, t),
  get: (runId: string) => traces.get(runId),
};
