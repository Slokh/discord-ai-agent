export async function waitForSandboxCallback(input: {
  readTaskStatus: () => Promise<string | undefined>;
  readJobStatus: () => Promise<{ failed?: number } | undefined>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}) {
  const deadline = Date.now() + (input.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    const taskStatus = await input.readTaskStatus();
    if (taskStatus === "no_changes") return;
    if (taskStatus && !["queued", "running"].includes(taskStatus)) {
      throw new Error(`Sandbox callback canary reached an unexpected terminal state (status=${taskStatus}).`);
    }
    const job = await input.readJobStatus();
    if ((job?.failed ?? 0) > 0) throw new Error("Sandbox scheduling canary Job failed.");
    await new Promise((resolve) => setTimeout(resolve, input.pollIntervalMs ?? 2_000));
  }
  const taskStatus = await input.readTaskStatus();
  throw new Error(`Sandbox callback canary did not reach a no-change terminal state (status=${taskStatus ?? "missing"}).`);
}
