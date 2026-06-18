import type {
  CanonicalEvent,
  DataQualityFlag,
  EventType,
  Hotel,
} from "../../types";
import { KNOWN_EVENT_TYPES } from "../../types";
import type { ModelClient } from "../../lib/anthropic";
import type { TraceRecorder } from "../../lib/trace";
import type { Logger } from "../../lib/logger";
import { extractedEventsSchema, type ExtractedEvent } from "./validator";

const TOOL = {
  name: "emit_events",
  description:
    "Emit every distinct front-desk event found in the free-text night log.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      events: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            sourceSpan: {
              type: "string",
              description:
                "The VERBATIM substring of the input prose this event was derived from. Copy it exactly, in its original language. Do not paraphrase.",
            },
            timestamp: {
              type: "string",
              description:
                "Best-guess ISO 8601 timestamp with the hotel's TZ offset.",
            },
            timestampApproximate: {
              type: "boolean",
              description:
                "true if the time was vague in the prose (e.g. 'around 1am').",
            },
            type: {
              type: "string",
              description: `One of: ${KNOWN_EVENT_TYPES.join(", ")}. Use 'unknown' if none fit.`,
            },
            room: { type: ["string", "null"] },
            guest: { type: ["string", "null"] },
            description: {
              type: "string",
              description:
                "Concise description IN THE ORIGINAL LANGUAGE of the prose. Preserve non-English text verbatim.",
            },
            status: { type: "string", enum: ["resolved", "unresolved", "pending"] },
          },
          required: [
            "sourceSpan",
            "timestamp",
            "timestampApproximate",
            "type",
            "description",
            "status",
          ],
        },
      },
    },
    required: ["events"],
  },
} as const;

function buildSystem(): string {
  return [
    "You extract structured front-desk events from a free-text overnight hotel log.",
    "Rules:",
    "- Emit one event per distinct incident or note worth passing to the morning team.",
    "- For EVERY event, sourceSpan MUST be an exact verbatim substring of the input. Never invent or paraphrase it.",
    "- Preserve the original language in `description` (e.g. keep Chinese passages in Chinese).",
    "- Do not invent incidents that are not in the text. If unsure, omit.",
    "- Vague times -> best-guess ISO timestamp and timestampApproximate=true.",
  ].join("\n");
}

function buildUser(log: string, hotel: Hotel): string {
  return [
    `Hotel timezone offset: ${hotel.timezone}.`,
    "A night shift runs ~23:00-07:00 and spans two calendar dates; use the dated headings in the log to anchor timestamps.",
    "",
    "FREE-TEXT NIGHT LOG:",
    "```",
    log,
    "```",
  ].join("\n");
}

// Collapse all whitespace runs to a single space so that span matching is
// robust to reflowed prose. Non-space scripts (e.g. Chinese) are unaffected.
function normWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function mapType(type: string): EventType {
  return (KNOWN_EVENT_TYPES as readonly string[]).includes(type)
    ? (type as EventType)
    : "unknown";
}

// string -> CanonicalEvent[] via LLM tool use, then code-side span verification.
// A returned sourceSpan not present in the original log => that event is DROPPED
// and a flag raised. This makes freetext events as traceable as JSON ones and
// blocks the model from inventing incidents.
export async function extractFreetextEvents(
  log: string,
  hotel: Hotel,
  deps: { model: ModelClient; trace: TraceRecorder; logger: Logger },
): Promise<{ events: CanonicalEvent[]; flags: DataQualityFlag[] }> {
  if (!log.trim()) return { events: [], flags: [] };

  const system = buildSystem();
  const user = buildUser(log, hotel);

  const { input, modelVersion } = await deps.model.callTool<{
    events: ExtractedEvent[];
  }>({ system, user, tool: TOOL, stage: "ingest" });

  deps.trace.recordExchange({
    stage: "ingest",
    tool: TOOL.name,
    system,
    user,
    response: input,
    modelVersion,
    temperature: 0,
  });

  const parsed = extractedEventsSchema.safeParse(input);
  if (!parsed.success) {
    deps.logger.warn(
      { stage: "ingest" },
      "freetext extractor returned malformed tool input",
    );
    return {
      events: [],
      flags: [
        {
          type: "low_quality_description",
          eventIds: [],
          note: "Freetext extraction returned a malformed shape; no events ingested.",
        },
      ],
    };
  }

  const normalisedLog = normWhitespace(log);
  const events: CanonicalEvent[] = [];
  const flags: DataQualityFlag[] = [];
  let idx = 0;

  for (const e of parsed.data.events) {
    const spanPresent = normalisedLog.includes(normWhitespace(e.sourceSpan));
    if (!spanPresent) {
      // Ungrounded — the model may have invented this. Drop it.
      flags.push({
        type: "low_quality_description",
        eventIds: [],
        note: `Dropped freetext event: sourceSpan not found in log ("${e.sourceSpan.slice(0, 60)}...").`,
      });
      continue;
    }
    const id = `ft_${String(++idx).padStart(4, "0")}`;
    events.push({
      id,
      source: "freetext",
      provenance: { kind: "freetext", sourceSpan: e.sourceSpan },
      timestamp: e.timestamp,
      timestampApproximate: e.timestampApproximate,
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

  return { events, flags };
}
