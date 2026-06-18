import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runPipeline } from "@/pipeline/pipeline";
import { fakeModel } from "./helpers/fakeModel";
import { nullTraceRecorder } from "@/lib/trace";
import { nullLogger } from "@/lib/logger";
import type { HandoverRequest, RawEvent } from "@/types";

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/events.json"), "utf8"),
) as { hotel: HandoverRequest["hotel"]; events: RawEvent[] };
const nightLog = readFileSync(resolve(__dirname, "fixtures/night-logs.md"), "utf8");

// A scripted model that mirrors what a correct LLM would return for the
// reference data — so the deterministic code (reconcile + verify) is exercised
// end-to-end with zero network calls.
const model = fakeModel({
  emit_events: {
    events: [
      {
        sourceSpan:
          "205 had the door ajar, bed clearly not slept in, no luggage anywhere in the room",
        timestamp: "2026-05-28T03:00:00+08:00",
        timestampApproximate: true,
        type: "incident",
        room: "205",
        guest: null,
        description: "Room 205 appears unoccupied though system shows in-house — possible ghost stay.",
        status: "unresolved",
      },
      {
        sourceSpan: "208 房的客人刚才下来说房间的保险箱打不开了",
        timestamp: "2026-05-28T03:30:00+08:00",
        timestampApproximate: true,
        type: "incident",
        room: "208",
        guest: null,
        description: "208 房客保险箱打不开，护照与现金锁在内，明早退房需尽快开锁。",
        status: "unresolved",
      },
      {
        sourceSpan: "312 那个 no-show",
        timestamp: "2026-05-28T01:00:00+08:00",
        timestampApproximate: true,
        type: "no_show",
        room: "312",
        guest: null,
        description: "312 no-show charged per booking terms (relief staff marked settled).",
        status: "resolved",
      },
    ],
  },
  propose_threads: {
    threads: [
      { eventIds: ["evt_0006", "evt_0007", "evt_0014"], reason: "room 309 deposit thread" },
      { eventIds: ["evt_0010", "ft_0003", "evt_0012"], reason: "room 312 no-show dispute" },
      { eventIds: ["evt_0002", "evt_0018"], reason: "room 112 aircon" },
      { eventIds: ["evt_0003", "evt_0009", "evt_0019"], reason: "passport backlog" },
    ],
  },
  emit_handover: {
    narrative:
      "Collect the room 309 deposit and submit the overdue passports first; investigate the room 312 charge dispute before acting. Rooms 205 and 208 need attention.",
    priorityActions: [
      {
        rank: 1,
        category: "financial",
        action: "Collect SGD 100 deposit from room 309 before checkout",
        context: "Card declined on arrival, never re-attempted.",
        deadline: "before checkout",
        citedEventIds: ["evt_0007", "evt_0014"],
      },
      {
        rank: 2,
        category: "compliance",
        action: "Submit overdue passports for rooms 204, 207, 210, 211 within 48 hours",
        context: "Immigration scanner was offline; backlog from earlier in the week.",
        deadline: "48 hours from check-in",
        citedEventIds: ["evt_0003", "evt_0009", "evt_0019"],
      },
      {
        rank: 3,
        category: "financial",
        action: "Investigate room 312 no-show charge dispute before acting",
        context: "Guest disputes the charge; contradictory records across nights.",
        citedEventIds: ["evt_0010", "evt_0012"],
      },
      {
        rank: 4,
        category: "operational",
        action: "Do not charge room 226 SGD 500 damage fee yet",
        context: "No photos and no manager approval on record.",
        citedEventIds: ["evt_0023"],
      },
      {
        rank: 5,
        category: "operational",
        action: "Confirm aircon vendor for room 112 repair",
        context: "Compressor part arrived; repair scheduled.",
        citedEventIds: ["evt_0002", "evt_0018"],
      },
    ],
    stillOpenSummary:
      "Room 205 possible ghost stay, room 208 safe-box stuck, room 214 flagged note, room 220 early-checkout refund, room 301 unwell guest, breakfast complaint all still open.",
  },
});

const ctx = { model, trace: nullTraceRecorder(), logger: nullLogger(), runId: "test-run" };

describe("pipeline (integration, scripted model)", () => {
  const req: HandoverRequest = {
    hotel: fixture.hotel,
    events: fixture.events,
    freetextLog: nightLog,
    targetShiftDate: "2026-05-29",
  };

  it("ingests both sources into one event log", async () => {
    const { report } = await runPipeline(req, ctx);
    // 26 JSON events + 3 freetext events that survived span verification.
    expect(report.events.length).toBe(29);
    expect(report.events.some((e) => e.source === "freetext" && e.room === "205")).toBe(true);
  });

  it("quarantines the evt_0026 prompt injection but keeps it in the report", async () => {
    const { report } = await runPipeline(req, ctx);
    const injected = report.events.find((e) => e.id === "evt_0026");
    expect(injected?.securityFlagged).toBe(true);
    expect(report.dataQualityFlags.some((f) => f.type === "security_concern")).toBe(true);
  });

  it("surfaces the room 312 contradiction across sources", async () => {
    const { report } = await runPipeline(req, ctx);
    const flag = report.dataQualityFlags.find((f) => f.type === "contradictory_status");
    expect(flag).toBeDefined();
    expect(flag!.eventIds).toEqual(expect.arrayContaining(["evt_0010", "evt_0012"]));
  });

  it("passes grounding when every action's entities appear in its cited events", async () => {
    const { report, verification } = await runPipeline(req, ctx);
    expect(verification.grounded).toBe(true);
    expect(report.priorityActions).toHaveLength(5);
    expect(report.priorityActions[0]!.rank).toBe(1);
  });

  it("produces a verification result object", async () => {
    const { verification } = await runPipeline(req, ctx);
    expect(verification).toHaveProperty("coverageComplete");
    expect(Array.isArray(verification.coverageGaps)).toBe(true);
  });
});
