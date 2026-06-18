import { z } from "zod";

// Zod is the single source of truth for runtime shapes at the API boundary.
// Inferred types are aligned with src/types.ts by construction.

export const eventStatusSchema = z.enum(["resolved", "unresolved", "pending"]);

// `type` is intentionally a loose string at the boundary — unknown types are
// tolerated and mapped to 'unknown' downstream, never rejected.
export const rawEventSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().min(1),
  type: z.string(),
  room: z.string().nullish(),
  guest: z.string().nullish(),
  description: z.string(),
  status: eventStatusSchema,
});

export const hotelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rooms: z.number().int().positive(),
  timezone: z.string().regex(/^[+-]\d{2}:\d{2}$/, "expected offset like +08:00"),
});

export const handoverRequestSchema = z.object({
  hotel: hotelSchema,
  events: z.array(rawEventSchema),
  freetextLog: z.string().optional(),
  targetShiftDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .optional(),
  idempotencyKey: z.string().optional(),
});

export type RawEventInput = z.infer<typeof rawEventSchema>;
export type HandoverRequestInput = z.infer<typeof handoverRequestSchema>;

// Shape the freetext extractor LLM must return, one entry per extracted event.
// Validated in code after the tool call; failures drop the single event.
export const extractedEventSchema = z.object({
  sourceSpan: z.string().min(1),
  timestamp: z.string().min(1),
  timestampApproximate: z.boolean(),
  type: z.string(),
  room: z.string().nullish(),
  guest: z.string().nullish(),
  description: z.string().min(1),
  status: eventStatusSchema,
});

export const extractedEventsSchema = z.object({
  events: z.array(extractedEventSchema),
});

export type ExtractedEvent = z.infer<typeof extractedEventSchema>;

// Shape the thread-linker LLM proposes. IDs are validated against real events.
export const proposedThreadSchema = z.object({
  eventIds: z.array(z.string()).min(1),
  reason: z.string(),
});

export const proposedThreadsSchema = z.object({
  threads: z.array(proposedThreadSchema),
});

export type ProposedThread = z.infer<typeof proposedThreadSchema>;

// Shape the generator LLM returns.
export const priorityActionSchema = z.object({
  rank: z.number().int(),
  category: z.enum([
    "safety",
    "compliance",
    "time_critical",
    "financial",
    "operational",
    "informational",
  ]),
  action: z.string().min(1),
  context: z.string(),
  deadline: z.string().optional(),
  citedEventIds: z.array(z.string()).min(1),
});

export const handoverDraftSchema = z.object({
  narrative: z.string().min(1),
  priorityActions: z.array(priorityActionSchema),
  stillOpenSummary: z.string(),
});
