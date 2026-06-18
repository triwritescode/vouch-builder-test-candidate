import { describe, it, expect } from "vitest";
import { ingestJsonEvents } from "@/pipeline/ingest/jsonIngestor";
import type { RawEvent } from "@/types";

describe("jsonIngestor", () => {
  it("maps known fields and sets provenance + requiresFollowUp", () => {
    const raw: RawEvent[] = [
      {
        id: "evt_0007",
        timestamp: "2026-05-27T00:15:00+08:00",
        type: "deposit_issue",
        room: "309",
        guest: "Jaydeep Suthkumar",
        description: "Card declined.",
        status: "unresolved",
      },
    ];
    const { events } = ingestJsonEvents(raw);
    expect(events[0]).toMatchObject({
      id: "evt_0007",
      source: "json",
      type: "deposit_issue",
      requiresFollowUp: true,
      provenance: { kind: "json", rawId: "evt_0007" },
    });
  });

  it("maps unknown event types to 'unknown' instead of throwing", () => {
    const { events } = ingestJsonEvents([
      {
        id: "x",
        timestamp: "2026-05-27T00:15:00+08:00",
        type: "totally_made_up",
        description: "d",
        status: "pending",
      },
    ]);
    expect(events[0]!.type).toBe("unknown");
  });

  it("handles null room/guest", () => {
    const { events } = ingestJsonEvents([
      {
        id: "x",
        timestamp: "2026-05-27T00:15:00+08:00",
        type: "facilities",
        room: null,
        guest: null,
        description: "leak",
        status: "unresolved",
      },
    ]);
    expect(events[0]!.room).toBeNull();
    expect(events[0]!.guest).toBeNull();
  });

  it("skips an invalid event and raises a flag rather than throwing", () => {
    const bad = { id: "bad", description: "no status or timestamp" } as unknown as RawEvent;
    const { events, flags } = ingestJsonEvents([bad]);
    expect(events).toHaveLength(0);
    expect(flags).toHaveLength(1);
  });
});
