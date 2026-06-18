import type {
  CanonicalEvent,
  DataQualityFlag,
  PriorityAction,
} from "../../types";

// Entities we can check deterministically against the cited events.
function extractRooms(text: string): string[] {
  return [...text.matchAll(/\b\d{3}\b/g)].map((m) => m[0]);
}

function extractAmounts(text: string): string[] {
  // "SGD 100", "SGD100", "$100" -> the bare number, which is what we match on.
  return [...text.matchAll(/(?:SGD|S\$|\$|USD)\s?(\d+(?:[.,]\d+)?)/gi)].map(
    (m) => m[1]!,
  );
}

function extractTimeWindows(text: string): string[] {
  return [...text.matchAll(/\b(\d+)\s?(?:h|hrs?|hours?)\b/gi)].map((m) => m[1]!);
}

// groundingVerifier (code) — the no-fabrication guarantee. Existence of a cited
// id is necessary but NOT sufficient: every concrete entity named in the action
// (room / amount / guest / time-window) must actually appear in one of its cited
// events. A violation demotes the action out of the ranked list into a flag.
export function verifyGrounding(
  actions: PriorityAction[],
  events: CanonicalEvent[],
): {
  groundedActions: PriorityAction[];
  violations: DataQualityFlag[];
} {
  const byId = new Map(events.map((e) => [e.id, e]));
  const knownGuests = [
    ...new Set(events.map((e) => e.guest).filter((g): g is string => !!g)),
  ];

  const groundedActions: PriorityAction[] = [];
  const violations: DataQualityFlag[] = [];

  for (const action of actions) {
    const text = `${action.action} ${action.context} ${action.deadline ?? ""}`;

    // Cited ids must exist.
    const unknown = action.citedEventIds.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      violations.push({
        type: "grounding_violation",
        eventIds: action.citedEventIds,
        note: `Action "${action.action}" cites unknown event id(s): ${unknown.join(", ")}.`,
      });
      continue;
    }

    const cited = action.citedEventIds.map((id) => byId.get(id)!);
    const haystack = cited
      .map((e) => `${e.description} ${e.room ?? ""} ${e.guest ?? ""}`)
      .join(" \n ");
    const haystackLower = haystack.toLowerCase();

    const missing: string[] = [];

    for (const room of new Set(extractRooms(text))) {
      if (!haystack.includes(room)) missing.push(`room ${room}`);
    }
    for (const amt of new Set(extractAmounts(text))) {
      if (!haystack.includes(amt)) missing.push(`amount ${amt}`);
    }
    for (const win of new Set(extractTimeWindows(text))) {
      // Only enforce if the cited events also talk in hours; otherwise skip
      // (the model may phrase a soft deadline that isn't a literal time window).
      if (/\b\d+\s?(?:h|hrs?|hours?)\b/i.test(haystack) && !haystack.includes(win)) {
        missing.push(`${win}h window`);
      }
    }
    for (const guest of knownGuests) {
      if (text.toLowerCase().includes(guest.toLowerCase()) &&
          !haystackLower.includes(guest.toLowerCase())) {
        missing.push(`guest ${guest}`);
      }
    }

    if (missing.length > 0) {
      violations.push({
        type: "grounding_violation",
        eventIds: action.citedEventIds,
        note: `Action "${action.action}" names ${missing.join(", ")} not found in its cited events. Demoted from priority list.`,
      });
      continue;
    }

    groundedActions.push(action);
  }

  return { groundedActions, violations };
}
