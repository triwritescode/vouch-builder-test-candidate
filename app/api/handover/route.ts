import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { handoverRequestSchema } from "@/pipeline/ingest/validator";
import { runPipeline } from "@/pipeline/pipeline";
import { createAnthropicClient } from "@/lib/anthropic";
import { createLogger } from "@/lib/logger";
import { createTraceRecorder, traceStore } from "@/lib/trace";
import { runStore } from "@/lib/store";
import { isAuthorised } from "@/lib/auth";
import { PipelineError } from "@/lib/errors";
import type { HandoverResponse } from "@/types";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = handoverRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const request = parsed.data;

  // Idempotency: same key returns the same prior run, no recomputation.
  if (request.idempotencyKey) {
    const existing = runStore.runIdForIdempotencyKey(request.idempotencyKey);
    if (existing) {
      const stored = runStore.get(existing);
      if (stored) return NextResponse.json(toResponse(stored, req), { status: 200 });
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "server misconfigured: ANTHROPIC_API_KEY not set" },
      { status: 500 },
    );
  }

  const runId = randomUUID();
  const shiftDate =
    request.targetShiftDate ??
    [...request.events.map((e) => e.timestamp)].sort().at(-1)?.slice(0, 10) ??
    "unknown";

  const logger = createLogger({ hotelId: request.hotel.id, shiftDate, runId });
  const trace = createTraceRecorder(runId, request.hotel.id, shiftDate);
  const model = createAnthropicClient(apiKey);

  try {
    logger.info({ stage: "ingest" }, "pipeline start");
    const { report, verification } = await runPipeline(request, {
      logger,
      trace,
      model,
      runId,
    });

    runStore.put({ runId, report, verification });
    traceStore.put(trace.snapshot());
    if (request.idempotencyKey) {
      runStore.mapIdempotencyKey(request.idempotencyKey, runId);
    }

    logger.info({ stage: "deliver" }, "pipeline complete");
    return NextResponse.json(
      toResponse({ runId, report, verification }, req),
      { status: 200 },
    );
  } catch (err) {
    const stage = err instanceof PipelineError ? err.stage : "unknown";
    const code = err instanceof PipelineError ? err.code : "INTERNAL";
    logger.error(
      { stage, error: { code, message: String(err) } },
      "pipeline failed",
    );
    return NextResponse.json(
      { error: "handover generation failed", code, stage, runId },
      { status: 500 },
    );
  }
}

function toResponse(
  stored: { runId: string; report: HandoverResponse["report"]; verification: HandoverResponse["verification"] },
  req: Request,
): HandoverResponse {
  const origin = new URL(req.url).origin;
  return {
    runId: stored.runId,
    report: stored.report,
    viewUrl: `${origin}/handover/${stored.runId}`,
    verification: stored.verification,
  };
}
