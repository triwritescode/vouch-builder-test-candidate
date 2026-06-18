import { describe, it, expect } from "vitest";
import { classifyState } from "@/pipeline/reconcile/stateClassifier";
import { normalise } from "@/pipeline/ingest/normaliser";
import type { CanonicalEvent, EventStatus, Hotel } from "@/types";

const HOTEL: Hotel = {
  id: "lumen-sg",
  name: "Lumen",
  rooms: 40,
  timezone: "+08:00",
};

function ce(
  id: string,
  timestamp: string,
  status: EventStatus,
  extra: Partial<CanonicalEvent> = {},
): CanonicalEvent {
  return {
    id,
    source: "json",
    provenance: { kind: "json", rawId: id },
    timestamp,
    timestampApproximate: false,
    shiftDate: "",
    type: "note",
    room: null,
    guest: null,
    description: "",
    status,
    requiresFollowUp: status !== "resolved",
    securityFlagged: false,
    threadId: null,
    ...extra,
  };
}

// Assign shiftDate via the real normaliser, then apply threadIds to simulate the
// validated linking step, so we test classification in isolation.
function prepare(events: CanonicalEvent[]): CanonicalEvent[] {
  return normalise(events, HOTEL.timezone).events;
}

describe("stateClassifier", () => {
  it("labels shift windows so after-midnight events belong to the prior 23:00 shift", () => {
    const evts = prepare([
      ce("a", "2026-05-29T23:30:00+08:00", "unresolved"),
      ce("b", "2026-05-30T02:00:00+08:00", "unresolved"),
    ]);
    expect(evts.find((e) => e.id === "a")!.shiftDate).toBe("2026-05-29");
    expect(evts.find((e) => e.id === "b")!.shiftDate).toBe("2026-05-29");
  });

  it("classifies new-tonight, still-open and newly-resolved across nights", () => {
    const evts = prepare([
      // deposit thread: opened earlier, still unresolved tonight
      ce("dep1", "2026-05-27T00:15:00+08:00", "unresolved", { threadId: "t-dep" }),
      ce("dep2", "2026-05-30T00:45:00+08:00", "unresolved", { threadId: "t-dep" }),
      // leak thread: opened earlier, resolved tonight -> newly-resolved
      ce("leak1", "2026-05-27T01:40:00+08:00", "unresolved", { threadId: "t-leak" }),
      ce("leak2", "2026-05-29T23:10:00+08:00", "resolved", { threadId: "t-leak" }),
      // brand new tonight
      ce("new1", "2026-05-30T02:40:00+08:00", "pending", { threadId: "t-new" }),
    ]);

    const { state } = classifyState(evts, HOTEL, "2026-05-29");

    expect(state.targetShift.shiftDate).toBe("2026-05-29");
    expect(state.newTonight.map((e) => e.id).sort()).toEqual(["dep2", "leak2", "new1"]);
    expect(state.stillOpen.map((t) => t.threadId).sort()).toEqual(["t-dep", "t-new"]);
    expect(state.newlyResolved.map((t) => t.threadId)).toEqual(["t-leak"]);
  });

  it("flags a contradiction when a thread is resolved then re-opens (room 312 case)", () => {
    const evts = prepare([
      ce("ns", "2026-05-27T02:30:00+08:00", "unresolved", { threadId: "t-312", room: "312" }),
      ce("settled", "2026-05-28T02:00:00+08:00", "resolved", { threadId: "t-312", room: "312" }),
      ce("dispute", "2026-05-28T23:30:00+08:00", "pending", { threadId: "t-312", room: "312" }),
    ]);

    const { state, flags } = classifyState(evts, HOTEL, "2026-05-28");
    const thread = state.stillOpen.find((t) => t.threadId === "t-312");
    expect(thread?.hasContradiction).toBe(true);
    expect(thread?.currentStatus).toBe("pending"); // most-recent wins
    expect(flags.some((f) => f.type === "contradictory_status")).toBe(true);
  });

  it("flags missing follow-up when an open thread goes >24h without an update", () => {
    const evts = prepare([
      ce("safe", "2026-05-27T03:00:00+08:00", "unresolved", { threadId: "t-safe", room: "208" }),
    ]);
    // target shift two nights later -> last update is >24h stale
    const { flags } = classifyState(evts, HOTEL, "2026-05-29");
    expect(flags.some((f) => f.type === "missing_followup")).toBe(true);
  });

  it("excludes events after the target shift from this handover's state", () => {
    const evts = prepare([
      ce("open", "2026-05-29T23:30:00+08:00", "unresolved", { threadId: "t-x" }),
      ce("future", "2026-05-31T23:30:00+08:00", "resolved", { threadId: "t-x" }),
    ]);
    const { state } = classifyState(evts, HOTEL, "2026-05-29");
    // The future resolution must not make the thread look resolved tonight.
    expect(state.stillOpen.map((t) => t.threadId)).toContain("t-x");
  });
});
