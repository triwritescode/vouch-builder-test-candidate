import { neon } from "@neondatabase/serverless";
import type { HandoverReport, VerificationResult } from "../types";

export interface StoredRun {
  runId: string;
  report: HandoverReport;
  verification: VerificationResult;
}

// Swappable run store behind one ASYNC interface. On Vercel, the POST route, the
// GET route, and the page each run in a SEPARATE lambda process — they do not
// share memory (a module singleton or globalThis pin only spans one process), so
// a run written by POST is invisible to the page → 404. Production therefore uses
// Postgres (Neon) so any process can read what another wrote. Without DATABASE_URL
// (local dev / tests) it falls back to an in-memory Map.
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

// Postgres (Neon serverless HTTP driver). Shared across all serverless
// instances, so the page render can read what the POST wrote. Schema is created
// lazily once per process; CREATE TABLE IF NOT EXISTS is idempotent.
class PgRunStore implements RunStore {
  readonly persistent = true;
  private sql: ReturnType<typeof neon>;
  private ready?: Promise<void>;

  constructor(connectionString: string) {
    this.sql = neon(connectionString);
  }

  private init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await this
          .sql`CREATE TABLE IF NOT EXISTS vouch_runs (run_id text PRIMARY KEY, data jsonb NOT NULL)`;
        await this
          .sql`CREATE TABLE IF NOT EXISTS vouch_idempotency (idem_key text PRIMARY KEY, run_id text NOT NULL)`;
      })();
    }
    return this.ready;
  }

  async put(run: StoredRun): Promise<void> {
    await this.init();
    await this.sql`
      INSERT INTO vouch_runs (run_id, data)
      VALUES (${run.runId}, ${JSON.stringify(run)}::jsonb)
      ON CONFLICT (run_id) DO UPDATE SET data = EXCLUDED.data`;
  }

  async get(runId: string): Promise<StoredRun | undefined> {
    await this.init();
    const rows = (await this
      .sql`SELECT data FROM vouch_runs WHERE run_id = ${runId}`) as {
      data: StoredRun;
    }[];
    return rows[0]?.data ?? undefined;
  }

  async runIdForIdempotencyKey(key: string): Promise<string | undefined> {
    await this.init();
    const rows = (await this
      .sql`SELECT run_id FROM vouch_idempotency WHERE idem_key = ${key}`) as {
      run_id: string;
    }[];
    return rows[0]?.run_id ?? undefined;
  }

  async mapIdempotencyKey(key: string, runId: string): Promise<void> {
    await this.init();
    await this.sql`
      INSERT INTO vouch_idempotency (idem_key, run_id)
      VALUES (${key}, ${runId})
      ON CONFLICT (idem_key) DO UPDATE SET run_id = EXCLUDED.run_id`;
  }
}

const dbUrl = process.env.DATABASE_URL;
const g = globalThis as typeof globalThis & { __vouchRunStore?: RunStore };
export const runStore: RunStore = dbUrl
  ? new PgRunStore(dbUrl)
  : (g.__vouchRunStore ??= new InMemoryRunStore());
