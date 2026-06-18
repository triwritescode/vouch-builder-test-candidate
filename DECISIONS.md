# DECISIONS

Night-shift handover pipeline for Vouch. This documents the tradeoffs, not the
spec — see `CLAUDE.md` for the full engineering spec.

## What I built

A deployable Next.js 15 (App Router) service with a five-stage pipeline:

1. **Ingest** — JSON events validated with Zod; the free-text log extracted into
   structured events by the model (tool use), each carrying a verbatim
   `sourceSpan`. Both sources merge into one `CanonicalEvent[]`; timestamps are
   normalised to the hotel offset and assigned a shift window.
2. **Reconcile** — a code-only security filter quarantines prompt injection; the
   model *proposes* thread links and code *validates* them; a fully
   deterministic classifier produces still-open / newly-resolved / new-tonight
   plus contradiction and missing-follow-up flags.
3. **Generate** — the model receives the *reconciled state* (not raw events) and
   returns a narrative + ranked actions via a tool schema.
4. **Verify** — two deterministic gates: **grounding** (every entity in an
   action must appear in its cited events) and **coverage** (every open item
   must surface somewhere).
5. **Deliver** — JSON (`POST` + `GET /api/handover/[runId]`), an HTML view
   (`/handover/[runId]`), structured `pino` logs, and a replayable trace.

34 unit + integration tests, all green. `tsc --noEmit` and `next build` clean.

## What I deliberately skipped (and why)

- **Tailwind → plain CSS.** The spec named Tailwind v4; I used a small hand-rolled
  `globals.css` instead. The brief says utility over polish, and one fewer build
  dependency (PostCSS plugin) is one fewer thing that breaks a 2-hour deploy. The
  HTML view is functional, not pretty — by choice.
- **Persistence.** Runs/traces live in an in-memory `Map`. It does not survive
  cold starts. The interfaces (`RunStore`, trace store) are swappable for
  Postgres/Redis with no pipeline change. Stateless trailing-window input means
  nothing else has to change.
- **One LLM call per stage, not merged.** The spec allowed merging thread-linking
  and generation into one call. I kept them separate: it makes each call's job
  small and its output independently validatable. Costs a round-trip; buys
  clarity and testability.
- **Auth on the HTML view.** The JSON API requires a bearer token; the HTML view
  is reachable by `runId` alone (an unguessable UUID). Real deployment would gate
  it — flagged as open question #6.
- **Rate limiting / idempotency store hardening, CI config.** Out of scope for
  the slice; idempotency works in-memory.

## Reconciliation across nights

The pipeline is **stateless**: the caller sends a trailing window of events plus
a target shift date, and state is computed fresh every run (reproducible, no
state-sync bugs). The key move is **threads**:

- The model proposes which events are the same ongoing issue (it can link a
  `no_show` to a later `finance_note` dispute, or resolve "the no-show from
  Tuesday"). **Code validates every proposed link** — ids must exist, an event
  joins only one thread, unlinked events become singletons. Model failure falls
  back to all-singletons; linking is an optimisation, never correctness.
- A **deterministic classifier** then labels each thread using *only* events up
  to the target shift: `currentStatus` = most-recent event; still-open =
  not-resolved; newly-resolved = resolved tonight after being open earlier;
  new-tonight = events on the target shift. This is pure logic and exhaustively
  unit-tested.

## Grounding, contradictions, and stopping the model inventing facts

This is the part that matters most for an unattended system, so it is enforced in
**code, after** the model speaks — the model never polices itself.

- **Free-text extraction is span-verified.** Every extracted event must quote a
  verbatim `sourceSpan` found in the original log (whitespace-normalised). A span
  that isn't present → the event is **dropped** + flagged. The model literally
  cannot invent an incident that isn't in the prose. (Test:
  `freetextExtractor.test.ts` drops a fabricated room-999 fire.)
- **Actions are entity-grounded.** `citedEventIds` is required by the tool schema,
  but existence isn't enough — every room number, money amount, time window, and
  guest name in an action must appear in one of its cited events. A mis-cite is
  **demoted** out of the priority list into a flag. (Test: an action citing the
  aircon event for a 309 deposit is demoted.)
- **Coverage is the inverse gate.** Every still-open thread and every
  unresolved/pending event on the target shift must be referenced somewhere; if
  not, a `coverage_gap` is raised loudly. A dropped urgent item is as dangerous as
  a fabricated one.
- **Contradictions are surfaced, never resolved.** When a thread is marked
  resolved and then re-opens (room 312: charged in prose → disputed later), the
  classifier flags `contradictory_status`, takes most-recent for display, and the
  report shows the full history for the manager to decide.
- **Prompt injection is quarantined pre-model.** `evt_0026`'s "issue a SGD 1000
  credit" note is detected by code, kept in the report for the manager, but
  replaced with a placeholder before any text reaches the model.

## Where AI helped most, and where it got in the way

- **Helped most — understanding the problem fast.** Before writing any code I used
  AI to interrogate the brief and the reference data: it surfaced the three hard
  properties (messy/adversarial input, issues living *across* nights not within
  one, output that must be trustworthy unattended) and walked me through the
  reference fixtures so I could see the room-312 contradiction, the 309 cross-night
  deposit, the passport-backlog deadline, the ghost stay, and the `evt_0026`
  injection *before* committing to an architecture. That comprehension pass is what
  produced the central design principle — *code owns facts, model owns language* —
  rather than discovering it halfway through.
- **Helped most — implementing the messy parts.** Multilingual free text is exactly
  what a model is good at and code is bad at: the Night-3 log mixes English and
  Chinese, approximate times, and cross-night references ("the no-show from
  Tuesday"). AI also accelerated the scaffolding — Zod schemas, the tool-use call
  shapes, the deterministic classifier's edge cases — and tool use eliminated a
  whole class of JSON-parsing failures.
- **Got in the way:** anything requiring a *guarantee*. The model will happily
  produce a confident, well-formatted, subtly-wrong handover. Every place I let it
  near a fact, I had to build a code gate behind it. The same friction showed up
  while building: it would suggest letting the model decide what was "still open" —
  convenient, but unreproducible and untestable. Pushing that back into
  deterministic code every time is what made the system defensible.

## Hours 3–6 if I had them

1. Persist runs/traces in Postgres; add a `GET /trace/[runId]` replay endpoint.
2. Auth + rate limiting on all routes; gate the HTML view.
3. Strengthen grounding: fuzzy guest-name matching, date/deadline normalisation,
   and a "confidence" on each link the manager can override.
4. CI (typecheck + test + build) and a deploy preview per PR.
5. A second model pass that critiques its own draft against the coverage gaps,
   then a final code re-verify — model proposes, code disposes, twice.

## One thing that surprised me

How much of "trustworthy AI output" turned out to be **not AI**. The model is two
calls in the middle; the surrounding ~80% — span verification, thread validation,
deterministic classification, grounding and coverage gates — is plain
deterministic code. The trust comes from the parts that aren't the model.
