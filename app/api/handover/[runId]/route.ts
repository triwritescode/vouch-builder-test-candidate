import { NextResponse } from "next/server";
import { runStore } from "@/lib/store";
import { isAuthorised } from "@/lib/auth";

export const runtime = "nodejs";

// GET /api/handover/[runId] — fetch a previously generated handover as JSON.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  if (!isAuthorised(req)) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const { runId } = await params;
  const stored = runStore.get(runId);
  if (!stored) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  const origin = new URL(req.url).origin;
  return NextResponse.json({
    runId: stored.runId,
    report: stored.report,
    viewUrl: `${origin}/handover/${stored.runId}`,
    verification: stored.verification,
  });
}
