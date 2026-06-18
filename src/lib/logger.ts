import pino from "pino";

// Structured JSON logging. Every log line in the pipeline is bound to
// { service, hotelId, shiftDate, runId, stage } so a bad handover can be traced
// to which hotel, which night, which stage. Guest PII never appears here — only
// event IDs — see §10/§13 of the spec.
export type Logger = pino.Logger;

export interface LogContext {
  hotelId: string;
  shiftDate: string;
  runId: string;
}

const base = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "vouch-handover" },
  // Redact anything that could carry a secret if a caller mislabels a field.
  redact: {
    paths: ["apiKey", "authorization", "*.apiKey", "*.authorization"],
    censor: "[redacted]",
  },
});

export function createLogger(ctx: LogContext): Logger {
  return base.child(ctx);
}

// A no-op logger for tests — same shape, zero output.
export function nullLogger(): Logger {
  return pino({ level: "silent" });
}
