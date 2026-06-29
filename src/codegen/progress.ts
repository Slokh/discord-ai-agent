export type CodegenProgressEvent = {
  step: string;
  message: string;
  metadata?: Record<string, unknown>;
};

export type CodegenProgressReporter = (event: CodegenProgressEvent) => Promise<void> | void;

export async function reportCodegenProgress(reporter: CodegenProgressReporter | undefined, event: CodegenProgressEvent) {
  if (!reporter) return;
  await reporter(event);
}
