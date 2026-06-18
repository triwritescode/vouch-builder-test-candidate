# Vouch Nightly Handover Pipeline — Engineering Spec

**Version:** 3.0  
**Stack:** Next.js 15 (App Router) · TypeScript · Vercel  
**Hotel (reference data):** Lumen Boutique Hotel (`lumen-sg`)

---

## 1. Problem Statement

Vouch operates hotel front desks overnight (23:00–07:00). When the night shift ends, the morning manager needs to know — within 60 seconds — what is on fire, what is pending, and what is just FYI. Not a chronological retelling of the night.

Today this handover is written by hand. Quality is inconsistent, issues get dropped across nights, and there is no standard format. This service automates it, running unattended across many hotels every morning.

Three properties make this hard, and the architecture is shaped entirely around them:

1. **The input is messy and partly adversarial** — mixed structured JSON and free-text prose, multiple languages, approximate times, terse shorthand, contradictions across nights, and at least one deliberate prompt-injection attempt embedded in guest-submitted text.
2. **Issues live across nights, not within one** — a deposit that failed on Tuesday is still uncollected on Friday morning. The system must track state over time, not summarise a single night.
3. **The output must be trustworthy enough to act on, unattended** — no human checks it before the manager acts. Every statement must trace to a source event, and no urgent item may be silently dropped.

---

## 2. Core Design Principle: Separate Facts from Narrative

The single most important decision in this design:

> **Code owns the facts. The model owns the language.**

| Owned by deterministic code                         | Owned by the LLM                                          |
| --------------------------------------------------- | --------------------------------------------------------- |
| Which events belong to the same thread (validation) | Which events belong to the same thread (proposal)         |
| What is new / still-open / newly-resolved           | Phrasing the narrative summary                            |
| Detecting contradictions                            | Ranking actions by urgency                                |
| Verifying grounding and coverage                    | Understanding messy, multilingual prose                   |
| Extracting deadlines, amounts, rooms                | Linking ambiguous references ("the no-show from Tuesday") |

**Why:** classification of state is pure logic once threads are linked — it must be reproducible and unit-testable, which an LLM is not. The LLM is reserved for the things only it can do well: understanding language and producing readable output. Everything the LLM produces is then **verified by code** before it reaches the manager.

This is what makes the system trustworthy at scale: the model is never the final authority on what is true.

---

## 3. Scope

A deployable pipeline that:

- Accepts structured JSON events and an optional free-text log over HTTP
- Reconciles them across nights into a state model: still-open / newly-resolved / new-tonight
- Generates an action-first handover, every statement grounded in a source event
- Verifies the handover two ways — nothing fabricated, nothing urgent omitted
- Serves JSON and a human-readable HTML view
- Emits a replayable trace and structured logs for debugging
- Is deployed and curl-able

Out of scope for this slice (architecture supports without rework): cron scheduling, push delivery (Slack/email), persistent multi-hotel storage.

---

## 4. Technology Decisions

| Concern           | Choice                                                         | Rationale                                                                |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Framework         | Next.js 15 (App Router)                                        | API Route Handlers + HTML view in one repo; user-specified               |
| Language          | TypeScript (strict)                                            | Types shared across API, pipeline, and UI                                |
| Validation        | Zod                                                            | Runtime enforcement at every boundary; single source of truth for shapes |
| AI                | `@anthropic-ai/sdk` with **tool use**                          | Structured output by construction — eliminates JSON-parse failures       |
| Determinism       | `temperature: 0` on all model calls                            | Reproducible runs; required for debuggability                            |
| Logging           | `pino`                                                         | Structured JSON; fastest Node logger; works on Vercel                    |
| Date/time         | `date-fns-tz`                                                  | Timezone-aware shift-window math; tree-shakeable                         |
| Styling           | Tailwind CSS v4                                                | Zero-config; HTML view only                                              |
| Linting / format  | ESLint (`eslint-config-next`, `@typescript-eslint`) + Prettier | Standard, enforced                                                       |
| Testing           | Vitest                                                         | Fast, Jest-compatible, no transform config                               |
| Deployment        | Vercel                                                         | Zero-config for Next.js                                                  |
| Run + trace store | In-memory `Map` (this slice)                                   | Swappable interface; production path in §17                              |

---

## 5. Input Contract

Input arrives as a POST body, never a file on disk — so the pipeline generalises to hotels and nights it has never seen.

### 5.1 Cross-night data flow — the key decision

A handover for a given morning must know what was already open. The pipeline is **stateless**: the caller sends a **bounded trailing window** of events (default: the 7 days ending at the target shift), plus the target shift date. The pipeline computes state fresh from that window every time.

**Why stateless over persisted per-hotel state:** a week of one hotel's events is tiny, so the payload stays small; runs are fully reproducible from their input; and there is no state-sync class of bugs. The persistence path (for longer histories / efficiency) is noted in §17 and does not change the pipeline.

### 5.2 POST `/api/handover`

```typescript
interface HandoverRequest {
  hotel: {
    id: string;
    name: string;
    rooms: number;
    timezone: string; // e.g. "+08:00"
  };
  events: RawEvent[]; // trailing-window structured events
  freetextLog?: string; // raw prose from relief staff (optional)
  targetShiftDate?: string; // YYYY-MM-DD (23:00 start date); default = latest shift in window
  idempotencyKey?: string; // optional; same key returns the same runId
}

interface RawEvent {
  id: string;
  timestamp: string; // ISO 8601 with TZ offset
  type: string; // unknown types tolerated, mapped to 'unknown'
  room?: string | null;
  guest?: string | null;
  description: string;
  status: "resolved" | "unresolved" | "pending";
}

interface HandoverResponse {
  runId: string;
  report: HandoverReport;
  viewUrl: string;
  verification: VerificationResult; // grounding + coverage outcome
}
```

### 5.3 curl Example

```bash
curl -X POST https://vouch-handover.vercel.app/api/handover \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $VOUCH_API_KEY" \
  -d @lumen-week.json
```

---

## 6. Pipeline Architecture

```
POST /api/handover
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. INGEST                          (code, + 1 LLM call)          │
│     • JSON events → CanonicalEvent[] (id = provenance)           │
│     • Freetext → CanonicalEvent[] via tool use                    │
│       each carries sourceSpan = verbatim prose substring          │
│     • Normalise timezones, sort, dedup-flag                       │
└──────────────────────────────┬────────────────────────────────────┘
                               │ CanonicalEvent[]
┌──────────────────────────────▼────────────────────────────────────┐
│  2. RECONCILE                                                      │
│     a. Security filter (code)    quarantine adversarial text       │
│     b. Thread linking            LLM PROPOSES links (cites IDs)     │
│                                  → CODE VALIDATES (IDs exist,       │
│                                    time order sane)                 │
│     c. State classification (code, deterministic)                  │
│        new-tonight / still-open / newly-resolved                   │
│        + contradiction detection                                   │
└──────────────────────────────┬────────────────────────────────────┘
                               │ ReconciledState
┌──────────────────────────────▼────────────────────────────────────┐
│  3. GENERATE                        (LLM, tool use, temp 0)        │
│     • Model receives RECONCILED STATE, not raw events             │
│     • Returns HandoverDraft via tool schema (shape guaranteed)     │
│       — narrative, ranked actions, each citing event IDs           │
└──────────────────────────────┬────────────────────────────────────┘
                               │ HandoverDraft
┌──────────────────────────────▼────────────────────────────────────┐
│  4. VERIFY                          (code, deterministic)         │
│     • GROUNDING: every entity (room/$/deadline/guest) in an        │
│       action must appear in its cited events  → else flag/demote   │
│     • COVERAGE: every unresolved/pending event must appear         │
│       somewhere in the report  → else coverage-gap flag            │
└──────────────────────────────┬────────────────────────────────────┘
                               │ HandoverReport + VerificationResult
┌──────────────────────────────▼────────────────────────────────────┐
│  5. DELIVER                                                        │
│     • JSON  (POST response, GET /api/handover/[runId])             │
│     • HTML  (GET /handover/[runId]) — grounding visible            │
│     • TRACE persisted: prompts, responses, model, verification     │
└─────────────────────────────────────────────────────────────────┘
```

Two LLM calls total: freetext extraction (step 1) and thread-link proposal + handover generation (steps 2b/3 may be one call or two — see §8.3). Every LLM output is validated by code downstream.

---

## 7. Domain Types

```typescript
// src/types.ts

export type EventSource = "json" | "freetext";
export type EventStatus = "resolved" | "unresolved" | "pending";

export type EventType =
  | "check_in"
  | "check_in_issue"
  | "check_out"
  | "early_checkout_request"
  | "no_show"
  | "walk_in"
  | "maintenance"
  | "facilities"
  | "complaint"
  | "compliance"
  | "lost_keycard"
  | "deposit_issue"
  | "damage_report"
  | "finance_note"
  | "incident"
  | "guest_message"
  | "note"
  | "unknown";

// Provenance is explicit and verifiable for BOTH sources.
export interface CanonicalEvent {
  id: string;
  source: EventSource;
  provenance:
    | { kind: "json"; rawId: string } // traces to original event id
    | { kind: "freetext"; sourceSpan: string }; // traces to verbatim prose substring
  timestamp: string; // ISO 8601, hotel TZ
  timestampApproximate: boolean;
  shiftDate: string; // computed shift window this event falls in
  type: EventType;
  room: string | null;
  guest: string | null;
  description: string; // original language preserved
  status: EventStatus;
  requiresFollowUp: boolean; // status !== 'resolved'
  securityFlagged: boolean;
  threadId: string | null; // assigned after validated linking
}

export interface Thread {
  threadId: string;
  eventIds: string[]; // chronological
  currentStatus: EventStatus; // from most-recent event
  firstSeenShift: string;
  lastUpdatedShift: string;
  hasContradiction: boolean;
}

export type DataQualityFlagType =
  | "contradictory_status"
  | "missing_followup"
  | "approximate_timestamp"
  | "security_concern"
  | "duplicate_suspected"
  | "invalid_thread_link" // LLM proposed a link code couldn't validate
  | "grounding_violation" // action entity not found in cited events
  | "coverage_gap" // unresolved event absent from the report
  | "low_quality_description";

export interface DataQualityFlag {
  type: DataQualityFlagType;
  eventIds: string[];
  note: string;
}

export interface PriorityAction {
  rank: number;
  category:
    | "safety"
    | "compliance"
    | "time_critical"
    | "financial"
    | "operational"
    | "informational";
  action: string; // imperative — what to do
  context: string;
  deadline?: string;
  citedEventIds: string[]; // REQUIRED, verified in step 4
}

export interface ReconciledState {
  hotel: HandoverRequest["hotel"];
  targetShift: { shiftDate: string; startISO: string; endISO: string };
  newTonight: CanonicalEvent[];
  stillOpen: Thread[]; // open at end of target shift (any origin night)
  newlyResolved: Thread[]; // were open, resolved during target shift
  contradictions: DataQualityFlag[];
  allEvents: CanonicalEvent[]; // full window, for verification + UI
}

export interface VerificationResult {
  grounded: boolean;
  coverageComplete: boolean;
  groundingViolations: DataQualityFlag[];
  coverageGaps: DataQualityFlag[];
}

export interface HandoverReport {
  runId: string;
  hotelId: string;
  hotelName: string;
  shiftDate: string;
  generatedAt: string;
  modelVersion: string; // pinned, for reproducibility
  narrative: string; // 2–4 sentence executive summary
  priorityActions: PriorityAction[];
  stillOpenSummary: string;
  newlyResolved: Thread[];
  dataQualityFlags: DataQualityFlag[];
  events: CanonicalEvent[]; // full log, all sources
}
```

---

## 8. Module Specifications

### 8.1 INGEST — `src/pipeline/ingest/`

**`jsonIngestor.ts`** — `RawEvent[] → CanonicalEvent[]`

- Validates each event with Zod; unknown `type` → `'unknown'` (never throws)
- `provenance = { kind: 'json', rawId: event.id }`
- Invalid events skipped, `DataQualityFlag` raised — never thrown

**`freetextExtractor.ts`** — `string → CanonicalEvent[]` (LLM, tool use)

- Calls Claude with a single tool, `emit_events`, whose input schema is `CanonicalEvent[]`-shaped. Tool use guarantees the response conforms — no JSON-string parsing.
- The model must, for every extracted event, return `sourceSpan`: the **verbatim substring** of the input prose the event was derived from.
- Original language preserved in `description`; all other fields in English.
- Vague times → best-guess ISO + `timestampApproximate: true`.
- **Span verification (code):** every returned `sourceSpan` must be found (normalised whitespace) in the original log. A span that isn't present → that event dropped + `DataQualityFlag`. This makes freetext events as traceable as JSON ones and blocks the model from inventing incidents.

**`normaliser.ts`** — merge both sources; normalise timestamps to hotel TZ via `date-fns-tz`; assign each event its `shiftDate` (the 23:00 window it falls in); sort; flag suspected duplicates (same room+guest+type within 10 min).

**`validator.ts`** — all Zod schemas; single source of truth, exported as schemas + inferred types.

### 8.2 RECONCILE — `src/pipeline/reconcile/`

**`securityFilter.ts`** (code, runs first) — `CanonicalEvent[] → { events, flags }`

- Detects guest text attempting to manipulate the pipeline. `evt_0026` is a real instance: a typed guest note ordering the system to clear all events and issue a SGD 1000 credit.
- Heuristics: text addressing the system ("system note", "handover tool", "ignore all"), embedded financial/operational directives ("add credit", "mark approved"), output-suppression instructions.
- On detection: `securityFlagged = true` (event stays in the report); `security_concern` flag raised; the description is replaced with a sanitised placeholder **before any text reaches the model**. Original preserved in `events` for the manager.

**`threadLinker.ts`** (LLM proposes → code validates)

- The LLM is given the event list (id, time, type, room, guest, description) and proposes groupings via tool use: each proposed thread is a list of `eventIds` it believes describe the same ongoing issue, with a one-line reason.
- This is where the model earns its place: it can link `no_show` (`evt_0010`) → `finance_note` dispute (`evt_0012`) across differing types, and resolve prose references like "the no-show from Tuesday."
- **Validation (code):** every proposed `eventId` must exist; events in a thread must be time-orderable; a proposed link that fails → discarded + `invalid_thread_link` flag. Events left unlinked become singleton threads. The model never silently creates structure code can't verify.

**`stateClassifier.ts`** (code, fully deterministic) — `Thread[] → ReconciledState`

- For each thread: `currentStatus` = status of its most-recent event.
- **new-tonight:** events whose `shiftDate` == target shift.
- **still-open:** threads whose `currentStatus !== 'resolved'` at end of target shift.
- **newly-resolved:** threads with a `resolved` event in the target shift that had an open event on an earlier shift.
- **contradiction:** a thread containing conflicting statuses across sources (e.g. JSON `unresolved` + freetext "charged") → `hasContradiction = true`, `contradictory_status` flag. Most-recent timestamp wins for `currentStatus`, but the contradiction is always surfaced.
- **missing-followup:** a thread `unresolved`/`pending` with no update for >24h within the window (e.g. room 208 safe).
- This module has zero LLM involvement and is exhaustively unit-tested against the reference fixtures.

### 8.3 GENERATE — `src/pipeline/generate/`

**`promptBuilder.ts`** — `ReconciledState → prompt`

- The model receives the **reconciled state**, not raw events — it does not recompute what is open. It only prioritises and phrases.
- Encodes the priority hierarchy (§11), the grounding rule (every action must cite ≥1 `citedEventId` from the provided events), the anti-hallucination rule, the language rule (preserve description language; generate in English), and the "action-first, not chronological" rule.
- Security-flagged descriptions are already sanitised upstream.

**`generator.ts`** — `prompt → HandoverDraft` (LLM, tool use, temp 0)

- Single tool `emit_handover` whose schema is the draft shape. Tool use guarantees structure.
- Records `modelVersion` and the full request/response into the trace (§10).
- No JSON-fence stripping anywhere — shape is structural, not parsed from text.

### 8.4 VERIFY — `src/pipeline/verify/`

**`groundingVerifier.ts`** (code) — the no-fabrication guarantee

- For each `PriorityAction`, extract concrete entities from `action` + `context`: room numbers (`/\b\d{3}\b/`), money amounts (`/SGD\s?\d+/`), guest names (matched against known event guests), deadlines/timeframes.
- Each extracted entity must appear in at least one of the action's `citedEventIds` (in that event's description/room/guest).
- A missing entity → `grounding_violation` flag; the action is demoted out of priority and into flags. Existence of the ID is necessary but **not sufficient** — the cited event must actually contain the claim's specifics.

**`coverageVerifier.ts`** (code) — the no-omission guarantee

- Every `still-open` thread and every `unresolved`/`pending` event in the target shift must be referenced by at least one priority action, the still-open summary, or the newly-resolved list.
- Anything unreferenced → `coverage_gap` flag, surfaced prominently. For an unattended system, a dropped urgent item is as dangerous as a fabricated one — this is the inverse of grounding and equally required.

### 8.5 ORCHESTRATION — `src/pipeline/pipeline.ts`

```typescript
export async function runPipeline(
  req: HandoverRequest,
  ctx: { logger: Logger; trace: TraceRecorder },
): Promise<{ report: HandoverReport; verification: VerificationResult }>;
```

Each stage is wrapped, timed, logged, and its LLM I/O recorded to the trace. Recoverable failures append a flag and continue; unrecoverable failures throw `PipelineError` with a `stage`. Dependencies (logger, trace) are injected so tests run with no-ops.

---

## 9. Grounding & Coverage — the trust backbone

The brief's central requirement — _"every statement traces back to the source, and flag incomplete or contradictory entries rather than paper over them"_ — is enforced as a **two-sided, deterministic gate** after generation. The model is never trusted to police itself.

**No fabrication (grounding).** Three layers:

1. _Schema_ — `citedEventIds` is a required field; tool use makes it non-optional.
2. _Entity match (code)_ — every room, amount, deadline, and guest named in an action must appear in its cited events. Catches mis-citation, not just missing citation.
3. _UI_ — each action shows its cited events as chips; clicking one reveals the original text in its original language.

**No omission (coverage).** Every open/pending item must surface somewhere in the report. Gaps are flagged loudly.

**Contradictions surfaced, never resolved silently.** The no-show charge for room 312 is the canonical case: `evt_0010` (uncharged) → Night-3 prose ("charged") → `evt_0012` (guest disputes). All three are linked into one thread, the contradiction is flagged, and the report shows the full history so the manager decides.

Worked example: an action _"Collect SGD 100 deposit from room 309 before checkout"_ must cite an event containing both "309" and "SGD 100" (e.g. `evt_0007` / `evt_0014`). If it cites only an aircon event, the entity check fails and the action is demoted to a flag.

---

## 10. Observability: Logs + Replayable Trace

Debuggability requires **reproducibility**, not just metrics.

**Structured logs (pino)** — every entry bound to `{ service, hotelId, shiftDate, runId, stage }`:

```typescript
interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  time: number;
  service: "vouch-handover";
  hotelId: string;
  shiftDate: string;
  runId: string;
  stage?: "ingest" | "reconcile" | "generate" | "verify" | "deliver";
  msg: string;
  durationMs?: number;
  eventCount?: number;
  threadCount?: number;
  openCount?: number;
  groundingViolations?: number;
  coverageGaps?: number;
  error?: { code: string; message: string; stack?: string };
}
```

**Replayable trace** — persisted per run, keyed by `runId`:

- the exact prompt(s) sent to the model
- the exact tool-call response(s) received
- `modelVersion`, `temperature: 0`
- the `ReconciledState` fed to generation
- the `VerificationResult`

With temperature pinned to 0 and the full trace stored, any builder — or an AI agent — can answer _which hotel, which night, which stage, and why_, and re-run the exact inputs to reproduce a bad handover. Guest PII never appears in logs (event IDs only); it lives only in the report and trace, which are access-controlled.

---

## 11. Priority Ranking

Encoded in the prompt; `category` on each action makes the ranking auditable:

1. **safety** — guest health, physical hazards
2. **compliance** — immigration deadlines, regulatory duties
3. **time_critical** — guests checking out within hours with blocking issues
4. **financial** — uncollected deposits, disputed/unapproved charges
5. **operational** — out-of-order rooms, facilities
6. **informational** — FYI / context

Expected top items for Night 5 of the reference data, each with citations:

1. Collect SGD 100 deposit, room 309, before checkout — `evt_0007`, `evt_0014`
2. Submit 4 overdue passports (204, 207, 210, 211); 48h immigration window — `evt_0003`, `evt_0009`, `evt_0019`
3. Investigate room 312 no-show charge dispute before acting — `evt_0010`, `evt_0012`
4. Do not charge room 226 damage fee — no photos, no manager approval — `evt_0023`
5. Confirm aircon vendor for room 112 repair — `evt_0002`, `evt_0018`
6. Reconcile room 205 occupancy — possible ghost stay (coverage from freetext span)

---

## 12. Data Quality & Edge Cases (from reference data)

| Issue                              | Source                                 | Handling                                                           |
| ---------------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| Contradictory status across nights | room 312 no-show                       | linked thread; most-recent wins; always flagged                    |
| Non-English freetext               | Night-3 Chinese passages               | preserved verbatim in `description`; `sourceSpan` keeps provenance |
| Approximate timestamps             | "around 1am", "~3am"                   | `timestampApproximate: true`; best-guess ISO                       |
| Missing follow-up                  | room 208 safe                          | `missing_followup` flag after >24h silence                         |
| Prompt injection                   | `evt_0026`                             | quarantined pre-model; stays in report; manager reviews original   |
| Ghost stay                         | room 205                               | open thread + flag; cannot auto-resolve without PMS                |
| Compliance deadline                | passport backlog                       | deadline extracted; high-priority action                           |
| Suspected duplicate                | `evt_0024` vs `evt_0006`               | distinct room+guest; duplicate flag cleared by normaliser          |
| Terse description                  | `evt_0015` "guest angry abt breakfast" | preserved; model expands; original retained                        |
| System-down night                  | Night 3 (freetext only)                | full report from prose alone; spans ground every claim             |

---

## 13. Security

- **Prompt injection** — §8.2; guest text never reaches the model verbatim.
- **API auth** — `Authorization: Bearer <VOUCH_API_KEY>` on all `/api/handover` routes; `401` otherwise.
- **Key handling** — `ANTHROPIC_API_KEY`, `VOUCH_API_KEY` are env-only; never in logs, responses, or errors.
- **PII** — guest data never in logs (event IDs only); present only in report/trace, which are access-controlled.

---

## 14. Error Handling

```typescript
type PipelineStage = "ingest" | "reconcile" | "generate" | "verify" | "deliver";
class PipelineError extends Error {
  constructor(
    message: string,
    public code: string,
    public stage: PipelineStage,
    public recoverable: boolean,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}
```

**Recoverable (continue, flag the report):** invalid single event; unverifiable `sourceSpan`; invalid proposed thread link; grounding violation (demote); coverage gap (flag).
**Unrecoverable (`500`, fully logged):** request body invalid (`400`); Claude auth failure; Claude error after retry. In multi-hotel use, one hotel's failure never blocks others.

---

## 15. Testing Strategy

| Layer                | What                                                                                            | How         |
| -------------------- | ----------------------------------------------------------------------------------------------- | ----------- |
| `validator`          | accepts valid, rejects invalid                                                                  | unit        |
| `jsonIngestor`       | nulls, unknown types, invalid events                                                            | unit        |
| `freetextExtractor`  | mocked tool response; span-verification drops fabricated events                                 | unit        |
| `normaliser`         | TZ math, shift-window assignment, dedup                                                         | unit        |
| `securityFilter`     | injection detected; sanitised text reaches model                                                | unit        |
| `threadLinker`       | valid links accepted; bad IDs / impossible order rejected                                       | unit        |
| `stateClassifier`    | new/open/resolved, contradiction, missing-followup — **deterministic, full reference fixtures** | unit        |
| `groundingVerifier`  | entity present passes; mis-citation demoted                                                     | unit        |
| `coverageVerifier`   | open event omitted → gap flagged                                                                | unit        |
| `generator`          | mocked tool call → valid draft                                                                  | unit        |
| `pipeline`           | end-to-end on reference data, mocked LLM                                                        | integration |
| `POST /api/handover` | auth, valid/invalid body, idempotency                                                           | API test    |

Fixtures: `events.json` + `night-logs.md` copied to `tests/fixtures/`.

---

## 16. File Structure

```
vouch-handover/
├── app/
│   ├── api/handover/
│   │   ├── route.ts                  # POST /api/handover
│   │   └── [runId]/route.ts          # GET  /api/handover/[runId]
│   ├── handover/[runId]/page.tsx     # HTML view
│   ├── layout.tsx
│   └── globals.css
├── src/
│   ├── pipeline/
│   │   ├── ingest/      { jsonIngestor, freetextExtractor, normaliser, validator }.ts
│   │   ├── reconcile/   { securityFilter, threadLinker, stateClassifier }.ts
│   │   ├── generate/    { promptBuilder, generator }.ts
│   │   ├── verify/      { groundingVerifier, coverageVerifier }.ts
│   │   └── pipeline.ts
│   ├── lib/             { logger, trace, store, errors, anthropic }.ts
│   └── types.ts
├── tests/
│   ├── fixtures/        { events.json, night-logs.md }
│   └── ... (mirrors src/pipeline)
├── .env.example
├── next.config.ts  ·  tailwind.config.ts  ·  tsconfig.json  ·  vitest.config.ts
└── package.json
```

---

## 17. Deployment & Production Path

**Deploy:** Vercel, zero-config. `/api/handover` becomes a serverless function; `/handover/[runId]` is server-rendered. Env vars set in the dashboard.

**Known limit of this slice:** the in-memory `Map` for runs/traces does not survive cold starts or multiple instances. Acceptable for a 2-hour slice. Production swap (no pipeline change): replace `store.ts` + `trace.ts` with Postgres (Supabase/Neon) or Redis (Upstash) behind the same interface. The stateless trailing-window input model means no other component needs to change.

---

## 18. Open Questions

| #   | Question                                          | Impact                                             |
| --- | ------------------------------------------------- | -------------------------------------------------- |
| 1   | PMS API for occupancy reconciliation?             | ghost-stay can only flag, not resolve, without it  |
| 2   | Exact Singapore immigration reporting deadline?   | compliance deadline precision                      |
| 3   | Trailing-window length — is 7 days always enough? | a thread older than the window loses early history |
| 4   | Push delivery (Slack/email/webhook) wanted?       | deliver-layer extension                            |
| 5   | Retention policy for events, reports, traces?     | replace in-memory store with DB                    |
| 6   | Should the HTML view require auth?                | currently reachable by runId alone                 |
