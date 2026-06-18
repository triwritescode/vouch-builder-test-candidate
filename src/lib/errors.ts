export type PipelineStage =
  | "ingest"
  | "reconcile"
  | "generate"
  | "verify"
  | "deliver";

export class PipelineError extends Error {
  constructor(
    message: string,
    public code: string,
    public stage: PipelineStage,
    public recoverable: boolean,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}
