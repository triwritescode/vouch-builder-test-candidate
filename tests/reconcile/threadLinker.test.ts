import { describe, it, expect } from "vitest";
import { linkThreads } from "@/pipeline/reconcile/threadLinker";
import { fakeModel, throwingModel } from "../helpers/fakeModel";
import { nullTraceRecorder } from "@/lib/trace";
import { nullLogger } from "@/lib/logger";
import type { CanonicalEvent } from "@/types";

function ce(id: string): CanonicalEvent {
  return {
    id,
    source: "json",
    provenance: { kind: "json", rawId: id },
    timestamp: "2026-05-27T00:15:00+08:00",
    timestampApproximate: false,
    shiftDate: "2026-05-26",
    type: "deposit_issue",
    room: "309",
    guest: null,
    description: "deposit",
    status: "unresolved",
    securityFlagged: false,
    requiresFollowUp: true,
    threadId: null,
  };
}

const ctx = (model: ReturnType<typeof fakeModel>) => ({
  model,
  trace: nullTraceRecorder(),
  logger: nullLogger(),
});

describe("threadLinker", () => {
  it("accepts a valid proposed link and assigns one threadId to its events", async () => {
    const events = [ce("evt_0006"), ce("evt_0007"), ce("evt_0014")];
    const model = fakeModel({
      propose_threads: { threads: [{ eventIds: ["evt_0006", "evt_0007", "evt_0014"], reason: "same deposit" }] },
    });
    const { events: out } = await linkThreads(events, ctx(model));
    const ids = new Set(out.map((e) => e.threadId));
    expect(ids.size).toBe(1);
  });

  it("discards a proposed link that references an unknown id", async () => {
    const events = [ce("evt_0006"), ce("evt_0007")];
    const model = fakeModel({
      propose_threads: { threads: [{ eventIds: ["evt_0006", "evt_9999"], reason: "bad" }] },
    });
    const { events: out, flags } = await linkThreads(events, ctx(model));
    expect(flags.some((f) => f.type === "invalid_thread_link")).toBe(true);
    // Both events fall back to distinct singleton threads.
    expect(new Set(out.map((e) => e.threadId)).size).toBe(2);
  });

  it("falls back to singleton threads when the model call fails", async () => {
    const events = [ce("evt_0006"), ce("evt_0007")];
    const { events: out, flags } = await linkThreads(events, {
      model: throwingModel(),
      trace: nullTraceRecorder(),
      logger: nullLogger(),
    });
    expect(new Set(out.map((e) => e.threadId)).size).toBe(2);
    expect(flags.some((f) => f.type === "invalid_thread_link")).toBe(true);
  });
});
