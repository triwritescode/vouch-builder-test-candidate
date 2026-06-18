import { notFound } from "next/navigation";
import { runStore } from "@/lib/store";
import type { CanonicalEvent } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function EventChip({ e }: { e: CanonicalEvent }) {
  return (
    <details className="chip">
      <summary>{e.id}</summary>
      <div className="meta">
        {e.type}
        {e.room ? ` · room ${e.room}` : ""}
        {e.guest ? ` · ${e.guest}` : ""} · {e.status}
        {e.timestampApproximate ? " · approx time" : ""}
        {e.securityFlagged ? " · ⚠ quarantined from model" : ""}
      </div>
      <div className="orig">{e.description}</div>
    </details>
  );
}

export default async function HandoverPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const stored = runStore.get(runId);
  if (!stored) notFound();

  const { report, verification } = stored;
  const byId = new Map(report.events.map((e) => [e.id, e]));
  const ok = verification.grounded && verification.coverageComplete;

  return (
    <main className="wrap">
      <h1>{report.hotelName} — Morning Handover</h1>
      <div className="sub">
        Shift {report.shiftDate} (23:00 → 07:00) · generated{" "}
        {new Date(report.generatedAt).toLocaleString()} · model{" "}
        {report.modelVersion} · run {report.runId}
      </div>

      <div className={`banner ${ok ? "ok" : "bad"}`}>
        {ok
          ? "✓ Verified — every statement grounded in a source event; no open item dropped."
          : `⚠ Verification flags — grounding violations: ${verification.groundingViolations.length}, coverage gaps: ${verification.coverageGaps.length}. Review flags below.`}
      </div>

      <h2>Summary</h2>
      <p>{report.narrative}</p>

      <h2>Priority actions</h2>
      {report.priorityActions.length === 0 && (
        <p className="sub">No priority actions produced.</p>
      )}
      {report.priorityActions.map((a) => (
        <div className="card" key={a.rank}>
          <div className="action">
            <div className="rank">{a.rank}</div>
            <div style={{ flex: 1 }}>
              <span className={`badge cat-${a.category}`}>{a.category}</span>
              {a.deadline && (
                <span className="deadline"> · {a.deadline}</span>
              )}
              <div>
                <strong>{a.action}</strong>
              </div>
              <div className="ctx">{a.context}</div>
              <div className="chips">
                {a.citedEventIds.map((id) => {
                  const e = byId.get(id);
                  return e ? <EventChip key={id} e={e} /> : null;
                })}
              </div>
            </div>
          </div>
        </div>
      ))}

      <h2>Still open</h2>
      <p>{report.stillOpenSummary}</p>

      {report.newlyResolved.length > 0 && (
        <>
          <h2>Newly resolved</h2>
          {report.newlyResolved.map((t) => (
            <div className="card" key={t.threadId}>
              <div className="tag">{t.eventIds.join(", ")}</div>
              {t.eventIds.map((id) => {
                const e = byId.get(id);
                return e ? <EventChip key={id} e={e} /> : null;
              })}
            </div>
          ))}
        </>
      )}

      {report.dataQualityFlags.length > 0 && (
        <>
          <h2>Data-quality flags</h2>
          {report.dataQualityFlags.map((f, i) => (
            <div className={`flag ${f.type}`} key={i}>
              <span className="ftype">{f.type}</span>
              {f.eventIds.length > 0 && (
                <span className="tag"> [{f.eventIds.join(", ")}]</span>
              )}
              <div>{f.note}</div>
            </div>
          ))}
        </>
      )}

      <h2>Full event log ({report.events.length})</h2>
      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>time</th>
            <th>type</th>
            <th>room</th>
            <th>status</th>
            <th>description</th>
          </tr>
        </thead>
        <tbody>
          {report.events.map((e) => (
            <tr key={e.id}>
              <td className="tag">{e.id}</td>
              <td className="tag">{e.timestamp.slice(5, 16).replace("T", " ")}</td>
              <td>{e.type}</td>
              <td>{e.room ?? "—"}</td>
              <td className={`st-${e.status}`}>{e.status}</td>
              <td>
                {e.securityFlagged && <span className="flagged">⚠ </span>}
                {e.description}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
