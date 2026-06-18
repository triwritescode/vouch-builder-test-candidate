import { describe, it, expect } from "vitest";
import { normalise } from "@/pipeline/ingest/normaliser";
import type { CanonicalEvent } from "@/types";

function ce(id: string, timestamp: string, over: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    id,
    source: "json",
    provenance: { kind: "json", rawId: id },
    timestamp,
    timestampApproximate: false,
    shiftDate: "",
    type: "check_in",
    room: null,
    guest: null,
    description: "",
    status: "resolved",
    requiresFollowUp: false,
    securityFlagged: false,
    threadId: null,
    ...over,
  };
}

describe("normaliser", () => {
  it("assigns shift windows across the 23:00 boundary", () => {
    const { events } = normalise(
      [
        ce("late", "2026-05-26T23:14:00+08:00"),
        ce("early", "2026-05-26T00:20:00+08:00"),
      ],
      "+08:00",
    );
    expect(events.find((e) => e.id === "late")!.shiftDate).toBe("2026-05-26");
    expect(events.find((e) => e.id === "early")!.shiftDate).toBe("2026-05-25");
  });

  it("sorts events chronologically", () => {
    const { events } = normalise(
      [
        ce("b", "2026-05-26T03:00:00+08:00"),
        ce("a", "2026-05-26T01:00:00+08:00"),
      ],
      "+08:00",
    );
    expect(events.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("flags suspected duplicates (same room+guest+type within 10 minutes)", () => {
    const { flags } = normalise(
      [
        ce("d1", "2026-05-26T01:00:00+08:00", { room: "210", guest: "X", type: "check_in" }),
        ce("d2", "2026-05-26T01:05:00+08:00", { room: "210", guest: "X", type: "check_in" }),
      ],
      "+08:00",
    );
    expect(flags.some((f) => f.type === "duplicate_suspected")).toBe(true);
  });

  it("does NOT flag distinct room/guest as duplicates (evt_0024 vs evt_0006 case)", () => {
    const { flags } = normalise(
      [
        ce("evt_0024", "2026-05-26T23:25:00+08:00", { room: "205", guest: "Daniel Chen", type: "check_in" }),
        ce("evt_0006", "2026-05-26T23:50:00+08:00", { room: "309", guest: "Jaydeep", type: "check_in_issue" }),
      ],
      "+08:00",
    );
    expect(flags.some((f) => f.type === "duplicate_suspected")).toBe(false);
  });

  it("flags approximate timestamps", () => {
    const { flags } = normalise(
      [ce("a", "2026-05-26T01:00:00+08:00", { timestampApproximate: true })],
      "+08:00",
    );
    expect(flags.some((f) => f.type === "approximate_timestamp")).toBe(true);
  });
});
