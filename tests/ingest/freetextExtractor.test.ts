import { describe, it, expect } from "vitest";
import { extractFreetextEvents } from "@/pipeline/ingest/freetextExtractor";
import { fakeModel } from "../helpers/fakeModel";
import { nullTraceRecorder } from "@/lib/trace";
import { nullLogger } from "@/lib/logger";
import type { Hotel } from "@/types";

const HOTEL: Hotel = { id: "lumen-sg", name: "Lumen", rooms: 40, timezone: "+08:00" };
const deps = () => ({ model: fakeModel({}), trace: nullTraceRecorder(), logger: nullLogger() });

const LOG = `Room 112 aircon — maintenance says compressor, part needs ordering. 112 stays out of order.
208 房的客人说保险箱打不开了，护照锁在里面，明天一早要退房。`;

describe("freetextExtractor", () => {
  it("keeps events whose sourceSpan is a verbatim substring of the log", async () => {
    const model = fakeModel({
      emit_events: {
        events: [
          {
            sourceSpan: "Room 112 aircon — maintenance says compressor, part needs ordering.",
            timestamp: "2026-05-27T00:30:00+08:00",
            timestampApproximate: true,
            type: "maintenance",
            room: "112",
            guest: null,
            description: "Aircon compressor fault, part on order; 112 out of order.",
            status: "unresolved",
          },
        ],
      },
    });
    const { events } = await extractFreetextEvents(LOG, HOTEL, {
      ...deps(),
      model,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe("freetext");
    expect(events[0]!.provenance).toMatchObject({ kind: "freetext" });
  });

  it("preserves non-English spans verbatim (Chinese safe-box note)", async () => {
    const model = fakeModel({
      emit_events: {
        events: [
          {
            sourceSpan: "208 房的客人说保险箱打不开了，护照锁在里面，明天一早要退房。",
            timestamp: "2026-05-27T03:00:00+08:00",
            timestampApproximate: true,
            type: "incident",
            room: "208",
            guest: null,
            description: "208 房的客人保险箱打不开，护照锁在内，明早退房。",
            status: "unresolved",
          },
        ],
      },
    });
    const { events } = await extractFreetextEvents(LOG, HOTEL, { ...deps(), model });
    expect(events).toHaveLength(1);
    expect(events[0]!.room).toBe("208");
  });

  it("DROPS a fabricated event whose sourceSpan is not in the log", async () => {
    const model = fakeModel({
      emit_events: {
        events: [
          {
            sourceSpan: "Guest in 999 reported a fire that never happened.",
            timestamp: "2026-05-27T04:00:00+08:00",
            timestampApproximate: false,
            type: "incident",
            room: "999",
            guest: null,
            description: "Invented incident.",
            status: "unresolved",
          },
        ],
      },
    });
    const { events, flags } = await extractFreetextEvents(LOG, HOTEL, { ...deps(), model });
    expect(events).toHaveLength(0);
    expect(flags.length).toBeGreaterThan(0);
  });
});
