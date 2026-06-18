import { kv } from "@vercel/kv";
import type { HandoverReport, VerificationResult } from "../types";

export interface StoredRun {
  runId: string;
  report: HandoverReport;
  verification: VerificationResult;
}

// Swappable run store behind one async interface. Production (Vercel) uses
// Vercel KV so a run written by the POST instance is readable by the GET/page
// instance — serverless invocations do not share process memory. Without KV
// creds (local dev / tests) it falls back to an in-memory Map.
export interface RunStore {
  readonly persistent: boolean;
  put(run: StoredRun): Promise<void>;
  get(runId: string): Promise<StoredRun | undefined>;
  runIdForIdempotencyKey(key: string): Promise<string | undefined>;
  mapIdempotencyKey(key: string, runId: string): Promise<void>;
}

// In-memory fallback. Does NOT survive cold starts / multiple instances — only
// safe for a single local process. Pinned to globalThis so all route bundles in
// one process share it (also survives dev HMR).
class InMemoryRunStore implements RunStore {
  readonly persistent = false;
  private runs = new Map<string, StoredRun>();
  private idempotency = new Map<string, string>();

  async put(run: StoredRun): Promise<void> {
    this.runs.set(run.runId, run);
  }
  async get(runId: string): Promise<StoredRun | undefined> {
    return this.runs.get(runId);
  }
  async runIdForIdempotencyKey(key: string): Promise<string | undefined> {
    return this.idempotency.get(key);
  }
  async mapIdempotencyKey(key: string, runId: string): Promise<void> {
    this.idempotency.set(key, runId);
  }
}

// Vercel KV (Upstash Redis under the hood). Shared across all serverless
// instances, so the page render can read what the POST wrote.
class KvRunStore implements RunStore {
  readonly persistent = true;

  async put(run: StoredRun): Promise<void> {
    await kv.set(`run:${run.runId}`, run);
  }
  async get(runId: string): Promise<StoredRun | undefined> {
    return (await kv.get<StoredRun>(`run:${runId}`)) ?? undefined;
  }
  async runIdForIdempotencyKey(key: string): Promise<string | undefined> {
    return (await kv.get<string>(`idem:${key}`)) ?? undefined;
  }
  async mapIdempotencyKey(key: string, runId: string): Promise<void> {
    await kv.set(`idem:${key}`, runId);
  }
}

const hasKv = Boolean(
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN,
);
const g = globalThis as typeof globalThis & { __vouchRunStore?: RunStore };
export const runStore: RunStore = hasKv
  ? new KvRunStore()
  : (g.__vouchRunStore ??= new InMemoryRunStore());
