import type {
  CanonicalEvent,
  DataQualityFlag,
  PriorityAction,
  ReconciledState,
} from "../../types";

// coverageVerifier (code) — the no-omission guarantee, the inverse of grounding.
// Every still-open thread and every unresolved/pending event on the target shift
// must surface somewhere in the report (a priority action, or the still-open
// summary / narrative by room reference). Anything unreferenced is a coverage_gap
// flagged loudly — for an unattended system a dropped urgent item is as dangerous
// as a fabricated one.
export function verifyCoverage(
  state: ReconciledState,
  actions: PriorityAction[],
  narrative: string,
  stillOpenSummary: string,
): { coverageComplete: boolean; gaps: DataQualityFlag[] } {
  const byId = new Map(state.allEvents.map((e) => [e.id, e]));
  const citedIds = new Set(actions.flatMap((a) => a.citedEventIds));
  const text = `${narrative} ${stillOpenSummary}`.toLowerCase();

  const eventReferenced = (e: CanonicalEvent): boolean => {
    if (citedIds.has(e.id)) return true;
    if (e.room && text.includes(e.room.toLowerCase())) return true;
    return false;
  };

  const threadReferenced = (eventIds: string[]): boolean =>
    eventIds.some((id) => {
      if (citedIds.has(id)) return true;
      const e = byId.get(id);
      return !!(e && e.room && text.includes(e.room.toLowerCase()));
    });

  const gaps: DataQualityFlag[] = [];
  const flagged = new Set<string>();

  // 1. Every still-open thread must be referenced.
  for (const t of state.stillOpen) {
    if (!threadReferenced(t.eventIds)) {
      gaps.push({
        type: "coverage_gap",
        eventIds: t.eventIds,
        note: `Still-open thread ${t.threadId} (status ${t.currentStatus}) is not referenced anywhere in the report.`,
      });
      t.eventIds.forEach((id) => flagged.add(id));
    }
  }

  // 2. Every unresolved/pending event on the target shift must be referenced.
  for (const e of state.newTonight) {
    if (e.status === "resolved") continue;
    if (flagged.has(e.id)) continue;
    if (!eventReferenced(e) && !threadReferenced([e.id])) {
      gaps.push({
        type: "coverage_gap",
        eventIds: [e.id],
        note: `New ${e.status} event ${e.id} on the target shift is not referenced anywhere in the report.`,
      });
    }
  }

  return { coverageComplete: gaps.length === 0, gaps };
}
