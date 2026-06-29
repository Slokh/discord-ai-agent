import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Check = {
  label: string;
  run: () => Promise<void>;
  required?: boolean;
};

const chartPath = "deploy/helm/discord-ai-agent";

const checks: Check[] = [
  {
    label: "git is available",
    run: async () => {
      await run("git", ["--version"]);
    },
    required: true
  },
  {
    label: "working tree has no uncommitted deploy changes",
    run: async () => {
      const output = await run("git", ["status", "--short"]);
      const deployChanges = output
        .split("\n")
        .filter((line) => line.trim())
        .filter((line) => / deploy\/|\.github\/workflows\/|Dockerfile|package\.json|package-lock\.json/.test(line));
      if (deployChanges.length) {
        throw new Error(`Uncommitted deploy-impacting files:\n${deployChanges.join("\n")}`);
      }
    },
    required: false
  },
  {
    label: "docker is available",
    run: async () => {
      await run("docker", ["--version"]);
    },
    required: true
  },
  {
    label: "helm is available",
    run: async () => {
      await run("helm", ["version", "--short"]);
    },
    required: true
  },
  {
    label: "helm chart lints",
    run: async () => {
      await run("helm", ["lint", chartPath]);
    },
    required: true
  },
  {
    label: "helm chart renders",
    run: async () => {
      await run("helm", [
        "template",
        "discord-ai-agent",
        chartPath,
        "--namespace",
        "discord-ai-agent",
        "--set",
        "image.repository=discord-ai-agent",
        "--set",
        "image.tag=preflight",
        "--set",
        "sandbox.image=discord-ai-agent-sandbox:preflight"
      ]);
    },
    required: true
  },
  {
    label: "kubectl is available",
    run: async () => {
      await run("kubectl", ["version", "--client=true"]);
    },
    required: false
  },
  {
    label: "aws cli is available",
    run: async () => {
      await run("aws", ["--version"]);
    },
    required: false
  },
  {
    label: "GitHub deploy settings are discoverable",
    run: async () => {
      await run("gh", ["variable", "list"]);
      await run("gh", ["secret", "list"]);
    },
    required: false
  }
];

async function main() {
  let failed = 0;
  for (const check of checks) {
    try {
      await check.run();
      console.log(`ok  - ${check.label}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (check.required) {
        failed += 1;
        console.error(`fail - ${check.label}\n${message}`);
      } else {
        console.warn(`warn - ${check.label}\n${message}`);
      }
    }
  }
  if (failed > 0) {
    throw new Error(`Deploy preflight failed ${failed} required check${failed === 1 ? "" : "s"}.`);
  }
  console.log("Deploy preflight passed.");
}

async function run(command: string, args: string[]) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  });
  return `${stdout}${stderr}`.trim();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
