import type { CanonicalEvent, DataQualityFlag, EventType } from "../../types";
import { KNOWN_EVENT_TYPES, type RawEvent } from "../../types";
import { rawEventSchema } from "./validator";

function mapType(type: string): EventType {
  return (KNOWN_EVENT_TYPES as readonly string[]).includes(type)
    ? (type as EventType)
    : "unknown";
}

// RawEvent[] -> CanonicalEvent[]. Never throws: an invalid event is skipped and
// a DataQualityFlag raised instead, so one bad row never sinks the run.
// shiftDate / timestamp normalisation is assigned by the normaliser downstream.
export function ingestJsonEvents(events: RawEvent[]): {
  events: CanonicalEvent[];
  flags: DataQualityFlag[];
} {
  const out: CanonicalEvent[] = [];
  const flags: DataQualityFlag[] = [];

  for (const raw of events) {
    const parsed = rawEventSchema.safeParse(raw);
    if (!parsed.success) {
      flags.push({
        type: "low_quality_description",
        eventIds: [typeof raw?.id === "string" ? raw.id : "unknown"],
        note: `Invalid JSON event skipped: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      });
      continue;
    }
    const e = parsed.data;
    out.push({
      id: e.id,
      source: "json",
      provenance: { kind: "json", rawId: e.id },
      timestamp: e.timestamp,
      timestampApproximate: false,
      shiftDate: "", // assigned by normaliser
      type: mapType(e.type),
      room: e.room ?? null,
      guest: e.guest ?? null,
      description: e.description,
      status: e.status,
      requiresFollowUp: e.status !== "resolved",
      securityFlagged: false,
      threadId: null,
    });
  }

  return { events: out, flags };
}
