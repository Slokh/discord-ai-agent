import { spawn } from "node:child_process";

export type PreflightStep = {
  label: string;
  command: string;
  args: string[];
};

export const preflightSteps: PreflightStep[] = [
  { label: "Start Postgres", command: "docker", args: ["compose", "up", "-d", "postgres"] },
  { label: "Run migrations", command: "npm", args: ["run", "migrate"] },
  { label: "Check configuration", command: "npm", args: ["run", "doctor"] },
  { label: "Print Discord invite URL", command: "npm", args: ["run", "invite-url"] },
  { label: "Smoke Discord", command: "npm", args: ["run", "smoke:discord"] },
  { label: "Smoke OpenRouter", command: "npm", args: ["run", "smoke:openrouter"] },
  { label: "Smoke GitHub", command: "npm", args: ["run", "smoke:github"] },
  { label: "Smoke startup", command: "npm", args: ["run", "smoke:startup"] },
  { label: "Clear stale slash commands", command: "npm", args: ["run", "clear-commands"] }
];

export type StepRunner = (step: PreflightStep) => Promise<number>;
export type PreflightWriter = (message: string) => void;

export async function runPreflight(
  steps: PreflightStep[] = preflightSteps,
  runner: StepRunner = runStep,
  write: PreflightWriter = (message) => process.stdout.write(message)
) {
  for (const [index, step] of steps.entries()) {
    write(`\n[${index + 1}/${steps.length}] ${step.label}\n`);
    const code = await runner(step);
    if (code !== 0) {
      throw new Error(`Preflight failed at "${step.label}" with exit code ${code}.`);
    }
  }
  write("\nDiscord AI Agent preflight passed.\n");
}

function runStep(step: PreflightStep) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(step.command, step.args, {
      stdio: "inherit",
      env: process.env
    });

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPreflight().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
