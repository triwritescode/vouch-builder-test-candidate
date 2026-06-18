// Domain types — the shared vocabulary across API, pipeline, and UI.
// Runtime shapes for the API boundary live in src/pipeline/ingest/validator.ts
// (Zod); these are the canonical TypeScript interfaces the code reasons over.

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

export const KNOWN_EVENT_TYPES: readonly EventType[] = [
  "check_in",
  "check_in_issue",
  "check_out",
  "early_checkout_request",
  "no_show",
  "walk_in",
  "maintenance",
  "facilities",
  "complaint",
  "compliance",
  "lost_keycard",
  "deposit_issue",
  "damage_report",
  "finance_note",
  "incident",
  "guest_message",
  "note",
  "unknown",
] as const;

export interface Hotel {
  id: string;
  name: string;
  rooms: number;
  timezone: string; // e.g. "+08:00"
}

export interface RawEvent {
  id: string;
  timestamp: string; // ISO 8601 with TZ offset
  type: string; // unknown types tolerated, mapped to 'unknown'
  room?: string | null;
  guest?: string | null;
  description: string;
  status: EventStatus;
}

export interface HandoverRequest {
  hotel: Hotel;
  events: RawEvent[];
  freetextLog?: string;
  targetShiftDate?: string; // YYYY-MM-DD (23:00 start date)
  idempotencyKey?: string;
}

// Provenance is explicit and verifiable for BOTH sources.
export type Provenance =
  | { kind: "json"; rawId: string }
  | { kind: "freetext"; sourceSpan: string };

export interface CanonicalEvent {
  id: string;
  source: EventSource;
  provenance: Provenance;
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
  | "invalid_thread_link"
  | "grounding_violation"
  | "coverage_gap"
  | "low_quality_description";

export interface DataQualityFlag {
  type: DataQualityFlagType;
  eventIds: string[];
  note: string;
}

export type PriorityCategory =
  | "safety"
  | "compliance"
  | "time_critical"
  | "financial"
  | "operational"
  | "informational";

export interface PriorityAction {
  rank: number;
  category: PriorityCategory;
  action: string; // imperative — what to do
  context: string;
  deadline?: string;
  citedEventIds: string[]; // REQUIRED, verified in step 4
}

export interface TargetShift {
  shiftDate: string;
  startISO: string;
  endISO: string;
}

export interface ReconciledState {
  hotel: Hotel;
  targetShift: TargetShift;
  newTonight: CanonicalEvent[];
  stillOpen: Thread[];
  newlyResolved: Thread[];
  contradictions: DataQualityFlag[];
  allEvents: CanonicalEvent[];
}

export interface VerificationResult {
  grounded: boolean;
  coverageComplete: boolean;
  groundingViolations: DataQualityFlag[];
  coverageGaps: DataQualityFlag[];
}

// What the LLM returns from emit_handover — narrative + ranked actions only.
// Code owns everything else in the final report.
export interface HandoverDraft {
  narrative: string;
  priorityActions: PriorityAction[];
  stillOpenSummary: string;
}

export interface HandoverReport {
  runId: string;
  hotelId: string;
  hotelName: string;
  shiftDate: string;
  generatedAt: string;
  modelVersion: string;
  narrative: string;
  priorityActions: PriorityAction[];
  stillOpenSummary: string;
  newlyResolved: Thread[];
  dataQualityFlags: DataQualityFlag[];
  events: CanonicalEvent[];
}

export interface HandoverResponse {
  runId: string;
  report: HandoverReport;
  viewUrl: string | null;
  verification: VerificationResult;
}
