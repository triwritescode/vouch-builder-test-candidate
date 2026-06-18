import type {
  DataQualityFlag,
  HandoverReport,
  HandoverRequest,
  PriorityAction,
  VerificationResult,
} from "../types";
import type { Logger } from "../lib/logger";
import type { TraceRecorder } from "../lib/trace";
import type { ModelClient } from "../lib/anthropic";

import { ingestJsonEvents } from "./ingest/jsonIngestor";
import { extractFreetextEvents } from "./ingest/freetextExtractor";
import { normalise } from "./ingest/normaliser";
import { applySecurityFilter } from "./reconcile/securityFilter";
import { linkThreads } from "./reconcile/threadLinker";
import { classifyState } from "./reconcile/stateClassifier";
import { generateHandover } from "./generate/generator";
import { verifyGrounding } from "./verify/groundingVerifier";
import { verifyCoverage } from "./verify/coverageVerifier";

export interface PipelineContext {
  logger: Logger;
  trace: TraceRecorder;
  model: ModelClient;
  runId: string;
}

async function timed<T>(
  logger: Logger,
  stage: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const t0 = Date.now();
  const result = await fn();
  logger.info({ stage, durationMs: Date.now() - t0 }, `stage ${stage} done`);
  return result;
}

// Orchestrates the five stages. Recoverable failures append a flag and continue;
// unrecoverable failures throw PipelineError (handled by the route as 500).
export async function runPipeline(
  req: HandoverRequest,
  ctx: PipelineContext,
): Promise<{ report: HandoverReport; verification: VerificationResult }> {
  const { logger, trace, model, runId } = ctx;
  const flags: DataQualityFlag[] = [];

  // 1. INGEST -------------------------------------------------------------
  const { events: jsonEvents, flags: jsonFlags } = await timed(
    logger,
    "ingest",
    () => ingestJsonEvents(req.events),
  );
  flags.push(...jsonFlags);

  const { events: ftEvents, flags: ftFlags } = await timed(
    logger,
    "ingest:freetext",
    () =>
      req.freetextLog
        ? extractFreetextEvents(req.freetextLog, req.hotel, { model, trace, logger })
        : { events: [], flags: [] },
  );
  flags.push(...ftFlags);

  const { events: normEvents, flags: normFlags } = normalise(
    [...jsonEvents, ...ftEvents],
    req.hotel.timezone,
  );
  flags.push(...normFlags);
  logger.info(
    { stage: "ingest", eventCount: normEvents.length },
    "ingest complete",
  );

  // 2. RECONCILE ----------------------------------------------------------
  const { events: securedEvents, flags: secFlags } = applySecurityFilter(normEvents);
  flags.push(...secFlags);

  const { events: linkedEvents, flags: linkFlags } = await timed(
    logger,
    "reconcile:link",
    () => linkThreads(securedEvents, { model, trace, logger }),
  );
  flags.push(...linkFlags);

  const { state, flags: stateFlags } = classifyState(
    linkedEvents,
    req.hotel,
    req.targetShiftDate,
  );
  flags.push(...stateFlags);
  trace.recordReconciledState(state);
  logger.info(
    {
      stage: "reconcile",
      threadCount: state.stillOpen.length + state.newlyResolved.length,
      openCount: state.stillOpen.length,
    },
    "reconcile complete",
  );

  // 3. GENERATE -----------------------------------------------------------
  const { draft, modelVersion } = await timed(logger, "generate", () =>
    generateHandover(state, { model, trace }),
  );

  // 4. VERIFY -------------------------------------------------------------
  const { groundedActions, violations } = verifyGrounding(
    draft.priorityActions,
    state.allEvents,
  );
  const ranked: PriorityAction[] = [...groundedActions]
    .sort((a, b) => a.rank - b.rank)
    .map((a, i) => ({ ...a, rank: i + 1 }));

  const { coverageComplete, gaps } = verifyCoverage(
    state,
    ranked,
    draft.narrative,
    draft.stillOpenSummary,
  );
  flags.push(...violations, ...gaps);

  const verification: VerificationResult = {
    grounded: violations.length === 0,
    coverageComplete,
    groundingViolations: violations,
    coverageGaps: gaps,
  };
  trace.recordVerification(verification);
  logger.info(
    {
      stage: "verify",
      groundingViolations: violations.length,
      coverageGaps: gaps.length,
    },
    "verify complete",
  );

  // 5. DELIVER (assemble) -------------------------------------------------
  const report: HandoverReport = {
    runId,
    hotelId: req.hotel.id,
    hotelName: req.hotel.name,
    shiftDate: state.targetShift.shiftDate,
    generatedAt: new Date().toISOString(),
    modelVersion,
    narrative: draft.narrative,
    priorityActions: ranked,
    stillOpenSummary: draft.stillOpenSummary,
    newlyResolved: state.newlyResolved,
    dataQualityFlags: dedupeFlags(flags),
    events: state.allEvents,
  };

  return { report, verification };
}

// Two flags are duplicates if same type + same eventIds + same note.
function dedupeFlags(flags: DataQualityFlag[]): DataQualityFlag[] {
  const seen = new Set<string>();
  const out: DataQualityFlag[] = [];
  for (const f of flags) {
    const key = `${f.type}|${[...f.eventIds].sort().join(",")}|${f.note}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
