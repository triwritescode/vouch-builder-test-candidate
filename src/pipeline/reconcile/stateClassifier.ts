import type {
  CanonicalEvent,
  DataQualityFlag,
  Hotel,
  ReconciledState,
  Thread,
} from "../../types";

const DAY_MS = 86_400_000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function byTimestamp(a: CanonicalEvent, b: CanonicalEvent): number {
  return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
}

// Fully deterministic. Threads come pre-assigned (threadId on every event).
// This module owns the SOURCE OF TRUTH for what is new / still-open /
// newly-resolved / contradictory / stale — no LLM involvement, exhaustively
// unit-tested against the reference fixtures.
export function classifyState(
  events: CanonicalEvent[],
  hotel: Hotel,
  targetShiftDate?: string,
): { state: ReconciledState; flags: DataQualityFlag[] } {
  const flags: DataQualityFlag[] = [];
  const tz = hotel.timezone;

  // Default target = the latest shift present in the window.
  const shiftDates = events.map((e) => e.shiftDate).filter(Boolean).sort();
  const target = targetShiftDate ?? shiftDates[shiftDates.length - 1] ?? "";
  const startISO = `${target}T23:00:00${tz}`;
  const endISO = `${addDaysYmd(target, 1)}T07:00:00${tz}`;
  const endMs = new Date(endISO).getTime();

  // Group by threadId.
  const groups = new Map<string, CanonicalEvent[]>();
  for (const e of events) {
    const key = e.threadId ?? e.id;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
  }

  const threads: Thread[] = [];
  for (const [threadId, groupEvents] of groups) {
    // Only events up to and including the target shift inform THIS handover.
    const inScope = groupEvents
      .filter((e) => e.shiftDate && e.shiftDate <= target)
      .sort(byTimestamp);
    if (inScope.length === 0) continue;

    const last = inScope[inScope.length - 1]!;
    const shifts = inScope.map((e) => e.shiftDate).sort();

    // Contradiction: a thread that was 'resolved' and then went non-resolved
    // again (status moved backwards) — e.g. room 312's no-show charge marked
    // settled in prose, then disputed/pending later. Surfaced, never auto-fixed.
    let hasContradiction = false;
    let sawResolved = false;
    for (const e of inScope) {
      if (e.status === "resolved") sawResolved = true;
      else if (sawResolved) hasContradiction = true;
    }

    const thread: Thread = {
      threadId,
      eventIds: inScope.map((e) => e.id),
      currentStatus: last.status,
      firstSeenShift: shifts[0]!,
      lastUpdatedShift: shifts[shifts.length - 1]!,
      hasContradiction,
    };
    threads.push(thread);

    if (hasContradiction) {
      flags.push({
        type: "contradictory_status",
        eventIds: thread.eventIds,
        note: "Thread was marked resolved then reappeared as open/disputed across sources. Most-recent status used; full history shown for the manager to decide.",
      });
    }

    // Missing follow-up: still open and no update within 24h of shift end.
    if (last.status !== "resolved") {
      const staleMs = endMs - new Date(last.timestamp).getTime();
      if (staleMs > DAY_MS) {
        flags.push({
          type: "missing_followup",
          eventIds: thread.eventIds,
          note: `Open thread with no update for >24h before the target shift ended (last update ${last.shiftDate}).`,
        });
      }
    }
  }

  const stillOpen = threads.filter((t) => t.currentStatus !== "resolved");

  const newlyResolved = threads.filter((t) => {
    if (t.currentStatus !== "resolved") return false;
    const threadEvents = (groups.get(t.threadId) ?? []).sort(byTimestamp);
    const resolvedTonight = threadEvents.some(
      (e) => e.status === "resolved" && e.shiftDate === target,
    );
    const openEarlier = threadEvents.some(
      (e) => e.status !== "resolved" && e.shiftDate < target,
    );
    return resolvedTonight && openEarlier;
  });

  const newTonight = events
    .filter((e) => e.shiftDate === target)
    .sort(byTimestamp);

  const contradictions = flags.filter((f) => f.type === "contradictory_status");

  const state: ReconciledState = {
    hotel,
    targetShift: { shiftDate: target, startISO, endISO },
    newTonight,
    stillOpen,
    newlyResolved,
    contradictions,
    allEvents: [...events].sort(byTimestamp),
  };

  return { state, flags };
}
