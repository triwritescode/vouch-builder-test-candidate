# Vouch Builder Take-Home

Welcome — thanks for taking the time.

**Start here:** read [`BRIEF.md`](BRIEF.md). It describes the task, what to build,
and how to submit.

Your sample data is in [`data/`](data/):
- `events.json` — structured front-desk events
- `night-logs.md` — one night logged as free text

Timebox is ~2 hours. We're looking for sharp tradeoffs, not completeness. Good luck.

---

## Implementation (candidate submission)

A Next.js 15 service that turns a trailing window of front-desk events into an
action-first morning handover. Design rationale: `DECISIONS.md`; full spec:
`CLAUDE.md`.

### Run locally

```bash
npm install
cp .env.example .env.local   # set ANTHROPIC_API_KEY and VOUCH_API_KEY
npm run dev                  # http://localhost:3000
```

```bash
npm test          # 34 unit + integration tests (no network, mocked model)
npm run typecheck # tsc --noEmit
npm run build     # production build
```

### Generate a handover

Build a request body from the sample data and POST it (the API takes data, never
a file path):

```bash
jq -n --slurpfile e data/events.json \
  --rawfile log data/night-logs.md \
  '{hotel: $e[0].hotel, events: $e[0].events, freetextLog: $log, targetShiftDate: "2026-05-29"}' \
  > /tmp/lumen-week.json

curl -s -X POST http://localhost:3000/api/handover \
  -H "Authorization: Bearer $VOUCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d @/tmp/lumen-week.json | jq '{runId, viewUrl, verification}'
```

Open the returned `viewUrl` for the human-readable handover, or
`GET /api/handover/<runId>` (same bearer token) for JSON.

### Deployed URL

`TODO: <vercel-url>` — set `ANTHROPIC_API_KEY` and `VOUCH_API_KEY` in the Vercel
dashboard, then use the same `curl` against the deployed origin.

### Architecture in one line

Code owns the facts, the model owns the language: two LLM calls (free-text
extraction, thread-link proposal + generation) sit between deterministic
ingest/reconcile gates and deterministic grounding/coverage verification, so no
statement reaches the manager unless code can trace it to a source event.
