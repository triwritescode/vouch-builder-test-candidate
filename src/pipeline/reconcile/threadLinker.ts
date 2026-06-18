import type { CanonicalEvent, DataQualityFlag } from "../../types";
import type { ModelClient } from "../../lib/anthropic";
import type { TraceRecorder } from "../../lib/trace";
import type { Logger } from "../../lib/logger";
import { proposedThreadsSchema, type ProposedThread } from "../ingest/validator";
import { modelSafeDescription } from "./securityFilter";

const TOOL = {
  name: "propose_threads",
  description:
    "Group events that describe the same ongoing issue across the week into threads.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      threads: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            eventIds: {
              type: "array",
              items: { type: "string" },
              description:
                "IDs of events that are the same ongoing issue, chronological.",
            },
            reason: {
              type: "string",
              description: "One line: why these belong together.",
            },
          },
          required: ["eventIds", "reason"],
        },
      },
    },
    required: ["threads"],
  },
} as const;

const SYSTEM = [
  "You link hotel front-desk events that describe the SAME ongoing issue across multiple nights.",
  "Examples of links: a no-show charge and a later dispute about it; a deposit that failed on arrival and is still uncollected days later; an aircon fault and its later repair update.",
  "Rules:",
  "- Only group events you are confident are the same issue. When unsure, leave an event out (it becomes its own thread).",
  "- Reference events ONLY by the exact id given. Never invent ids.",
  "- A linked group may span different event types and rooms if context shows they are the same thread.",
].join("\n");

function buildUser(events: CanonicalEvent[]): string {
  const rows = events.map((e) => ({
    id: e.id,
    time: e.timestamp,
    type: e.type,
    room: e.room,
    guest: e.guest,
    description: modelSafeDescription(e),
  }));
  return `Events:\n${JSON.stringify(rows, null, 2)}`;
}

// LLM proposes groupings -> code validates and assigns threadIds. Every proposed
// id must exist; an event may belong to only one thread (first claim wins);
// unlinked events become singleton threads. Invalid proposals are discarded with
// an invalid_thread_link flag. Model failure falls back to all-singletons.
export async function linkThreads(
  events: CanonicalEvent[],
  deps: { model: ModelClient; trace: TraceRecorder; logger: Logger },
): Promise<{ events: CanonicalEvent[]; flags: DataQualityFlag[] }> {
  const flags: DataQualityFlag[] = [];
  const byId = new Map(events.map((e) => [e.id, e]));
  const assigned = new Map<string, string>(); // eventId -> threadId
  let threadCounter = 0;
  const nextThreadId = () => `thr_${String(++threadCounter).padStart(4, "0")}`;

  let proposed: ProposedThread[] = [];
  if (events.length > 1) {
    try {
      const user = buildUser(events);
      const { input, modelVersion } = await deps.model.callTool<{
        threads: ProposedThread[];
      }>({ system: SYSTEM, user, tool: TOOL, stage: "reconcile" });

      deps.trace.recordExchange({
        stage: "reconcile",
        tool: TOOL.name,
        system: SYSTEM,
        user,
        response: input,
        modelVersion,
        temperature: 0,
      });

      const parsed = proposedThreadsSchema.safeParse(input);
      if (parsed.success) proposed = parsed.data.threads;
      else
        flags.push({
          type: "invalid_thread_link",
          eventIds: [],
          note: "Thread proposal had a malformed shape; defaulted to singletons.",
        });
    } catch (err) {
      // Recoverable: linking is an optimisation, not correctness-critical.
      deps.logger.warn(
        { stage: "reconcile", err: String(err) },
        "thread linking failed; falling back to singleton threads",
      );
      flags.push({
        type: "invalid_thread_link",
        eventIds: [],
        note: "Thread linking call failed; every event treated as its own thread.",
      });
    }
  }

  // Validate each proposed thread before trusting it.
  for (const t of proposed) {
    const unknown = t.eventIds.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      flags.push({
        type: "invalid_thread_link",
        eventIds: t.eventIds,
        note: `Proposed link references unknown id(s): ${unknown.join(", ")}. Discarded.`,
      });
      continue;
    }
    const fresh = t.eventIds.filter((id) => !assigned.has(id));
    if (fresh.length === 0) continue; // all already claimed by earlier threads
    if (fresh.length < 2) {
      // Nothing actually linked after dedupe — let it fall through to singleton.
      continue;
    }
    const threadId = nextThreadId();
    for (const id of fresh) assigned.set(id, threadId);
  }

  // Assign final threadIds; unlinked events become singletons.
  const out = events.map((e) => {
    const threadId = assigned.get(e.id) ?? nextThreadId();
    if (!assigned.has(e.id)) assigned.set(e.id, threadId);
    return { ...e, threadId };
  });

  return { events: out, flags };
}
