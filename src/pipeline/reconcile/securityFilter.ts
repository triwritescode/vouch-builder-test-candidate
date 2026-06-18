import type { CanonicalEvent, DataQualityFlag } from "../../types";

export const SANITIZED_PLACEHOLDER =
  "[guest-submitted text quarantined: possible prompt-injection — see original in report]";

// Heuristics for guest text attempting to manipulate the pipeline. evt_0026 is
// the canonical instance: a typed note ordering the tool to clear all events and
// issue a SGD 1000 credit. We err toward flagging — a false positive only costs
// the model a placeholder; the manager always sees the original.
const INJECTION_PATTERNS: RegExp[] = [
  // Addressing the system / tool directly.
  /\bsystem note\b/i,
  /\bhandover (tool|system|report)\b/i,
  /\bignore (all|any|previous|other|the above)\b/i,
  /\bdisregard (all|any|previous|the)\b/i,
  /\bprompt\b/i,
  // Embedded financial / operational directives.
  /\badd (a )?(sgd|usd|\$)?\s?\d+.*(credit|refund)\b/i,
  /\bgoodwill credit\b/i,
  /\b(mark|set) .*(approved|resolved|paid|cleared)\b/i,
  /\bissue (a )?(credit|refund)\b/i,
  // Output suppression / falsification.
  /\breport .*(all clear|nothing|as clear)\b/i,
  /\bclear all (events|items|entries)\b/i,
];

function looksAdversarial(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

// Runs first in RECONCILE, before any text reaches the model. Flagged events
// stay in the report (description untouched, for the manager); a security_concern
// flag is raised. Model-facing prompts substitute SANITIZED_PLACEHOLDER via
// modelSafeDescription() so the raw guest text is never sent to the LLM.
export function applySecurityFilter(events: CanonicalEvent[]): {
  events: CanonicalEvent[];
  flags: DataQualityFlag[];
} {
  const flags: DataQualityFlag[] = [];
  const out = events.map((e) => {
    if (looksAdversarial(e.description)) {
      flags.push({
        type: "security_concern",
        eventIds: [e.id],
        note: "Guest-submitted text resembles a prompt-injection / operational directive. Quarantined from the model; original retained for manager review.",
      });
      return { ...e, securityFlagged: true };
    }
    return e;
  });
  return { events: out, flags };
}

// The only description any model-facing prompt should use. Quarantined events
// yield a neutral placeholder; everything else passes through unchanged.
export function modelSafeDescription(e: CanonicalEvent): string {
  return e.securityFlagged ? SANITIZED_PLACEHOLDER : e.description;
}
