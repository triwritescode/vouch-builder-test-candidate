import { describe, it, expect } from "vitest";
import { verifyGrounding } from "@/pipeline/verify/groundingVerifier";
import type { CanonicalEvent, PriorityAction } from "@/types";

function ev(id: string, description: string, room: string | null = null): CanonicalEvent {
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
    description,
    status: "unresolved",
    requiresFollowUp: true,
    securityFlagged: false,
    threadId: null,
  };
}

function action(over: Partial<PriorityAction>): PriorityAction {
  return {
    rank: 1,
    category: "financial",
    action: "do thing",
    context: "",
    citedEventIds: [],
    ...over,
  };
}

const depositEvent = ev(
  "evt_0014",
  "The SGD 100 deposit was never collected. Flag to finance before checkout.",
  "309",
);
const airconEvent = ev("evt_0018", "Aircon compressor for room 112 scheduled.", "112");

describe("groundingVerifier", () => {
  it("passes an action whose room and amount appear in its cited event", () => {
    const { groundedActions, violations } = verifyGrounding(
      [
        action({
          action: "Collect SGD 100 deposit from room 309 before checkout",
          citedEventIds: ["evt_0014"],
        }),
      ],
      [depositEvent],
    );
    expect(groundedActions).toHaveLength(1);
    expect(violations).toHaveLength(0);
  });

  it("demotes an action that cites the wrong event (entity missing)", () => {
    const { groundedActions, violations } = verifyGrounding(
      [
        action({
          action: "Collect SGD 100 deposit from room 309 before checkout",
          citedEventIds: ["evt_0018"], // aircon event — has neither 309 nor 100
        }),
      ],
      [depositEvent, airconEvent],
    );
    expect(groundedActions).toHaveLength(0);
    expect(violations[0]!.type).toBe("grounding_violation");
    expect(violations[0]!.note).toContain("room 309");
  });

  it("rejects an action that cites a non-existent event id", () => {
    const { groundedActions, violations } = verifyGrounding(
      [action({ action: "do thing", citedEventIds: ["evt_9999"] })],
      [depositEvent],
    );
    expect(groundedActions).toHaveLength(0);
    expect(violations[0]!.note).toContain("unknown event id");
  });
});
