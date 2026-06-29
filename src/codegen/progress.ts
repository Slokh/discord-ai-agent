export type CodegenProgressEvent = {
  step: string;
  message: string;
  eventName?: string;
  level?: "debug" | "info" | "warn" | "error";
  durationMs?: number | null;
  updateJobStatus?: boolean;
  metadata?: Record<string, unknown>;
};

export type CodegenProgressReporter = (event: CodegenProgressEvent) => Promise<void> | void;

export async function reportCodegenProgress(reporter: CodegenProgressReporter | undefined, event: CodegenProgressEvent) {
  if (!reporter) return;
  await reporter(event);
}
