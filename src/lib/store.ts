import type { HandoverReport, VerificationResult } from "../types";

export interface StoredRun {
  runId: string;
  report: HandoverReport;
  verification: VerificationResult;
}

// Swappable run store. This slice uses an in-memory Map (does not survive cold
// starts / multiple instances — acceptable per §17). Production swaps this for
// Postgres/Redis behind the same interface; nothing else changes.
export interface RunStore {
  put(run: StoredRun): void;
  get(runId: string): StoredRun | undefined;
  runIdForIdempotencyKey(key: string): string | undefined;
  mapIdempotencyKey(key: string, runId: string): void;
}

class InMemoryRunStore implements RunStore {
  private runs = new Map<string, StoredRun>();
  private idempotency = new Map<string, string>();

  put(run: StoredRun): void {
    this.runs.set(run.runId, run);
  }
  get(runId: string): StoredRun | undefined {
    return this.runs.get(runId);
  }
  runIdForIdempotencyKey(key: string): string | undefined {
    return this.idempotency.get(key);
  }
  mapIdempotencyKey(key: string, runId: string): void {
    this.idempotency.set(key, runId);
  }
}

// Next bundles each route segment separately, so a plain module-level singleton
// would give POST, GET, and the page their OWN empty Map. Pin it to globalThis
// so every bundle in the process shares one store (also survives dev HMR).
const g = globalThis as typeof globalThis & { __vouchRunStore?: RunStore };
export const runStore: RunStore = (g.__vouchRunStore ??= new InMemoryRunStore());
