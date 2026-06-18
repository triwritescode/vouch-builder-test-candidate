import { describe, it, expect } from "vitest";
import { verifyCoverage } from "@/pipeline/verify/coverageVerifier";
import type {
  CanonicalEvent,
  PriorityAction,
  ReconciledState,
  Thread,
} from "@/types";

function ev(id: string, room: string | null, status: CanonicalEvent["status"]): CanonicalEvent {
  return {
    id,
    source: "json",
    provenance: { kind: "json", rawId: id },
    timestamp: "2026-05-30T00:45:00+08:00",
    timestampApproximate: false,
    shiftDate: "2026-05-29",
    type: "deposit_issue",
    room,
    guest: null,
    description: "",
    status,
    requiresFollowUp: status !== "resolved",
    securityFlagged: false,
    threadId: id,
  };
}

function thread(threadId: string, eventIds: string[]): Thread {
  return {
    threadId,
    eventIds,
    currentStatus: "unresolved",
    firstSeenShift: "2026-05-29",
    lastUpdatedShift: "2026-05-29",
    hasContradiction: false,
  };
}

function state(over: Partial<ReconciledState>): ReconciledState {
  return {
    hotel: { id: "h", name: "h", rooms: 1, timezone: "+08:00" },
    targetShift: { shiftDate: "2026-05-29", startISO: "", endISO: "" },
    newTonight: [],
    stillOpen: [],
    newlyResolved: [],
    contradictions: [],
    allEvents: [],
    ...over,
  };
}

describe("coverageVerifier", () => {
  it("passes when every still-open thread is cited by an action", () => {
    const e = ev("evt_0014", "309", "unresolved");
    const s = state({ stillOpen: [thread("evt_0014", ["evt_0014"])], allEvents: [e] });
    const actions: PriorityAction[] = [
      { rank: 1, category: "financial", action: "Collect deposit", context: "", citedEventIds: ["evt_0014"] },
    ];
    const { coverageComplete, gaps } = verifyCoverage(s, actions, "", "");
    expect(coverageComplete).toBe(true);
    expect(gaps).toHaveLength(0);
  });

  it("flags a coverage gap when an open thread is referenced nowhere", () => {
    const e = ev("evt_0014", "309", "unresolved");
    const s = state({ stillOpen: [thread("evt_0014", ["evt_0014"])], allEvents: [e] });
    const { coverageComplete, gaps } = verifyCoverage(s, [], "Quiet night.", "Nothing open.");
    expect(coverageComplete).toBe(false);
    expect(gaps[0]!.type).toBe("coverage_gap");
  });

  it("accepts a thread referenced only by room number in the still-open summary", () => {
    const e = ev("evt_0014", "309", "unresolved");
    const s = state({ stillOpen: [thread("evt_0014", ["evt_0014"])], allEvents: [e] });
    const { coverageComplete } = verifyCoverage(s, [], "", "Room 309 deposit still outstanding.");
    expect(coverageComplete).toBe(true);
  });
});
