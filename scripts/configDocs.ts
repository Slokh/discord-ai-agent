import fs from "node:fs/promises";
import path from "node:path";
import { environmentVariables, type EnvironmentVariableDefinition, type EnvironmentVariableGroup } from "../src/config/environment.js";

const variables: readonly EnvironmentVariableDefinition[] = environmentVariables;

const write = process.argv.includes("--write");
const files = new Map([
  [".env.example", renderEnvExample()],
  ["docs/configuration.md", renderConfigurationGuide()],
]);

for (const [file, expected] of files) {
  const absolute = path.resolve(file);
  if (write) {
    await fs.writeFile(absolute, expected);
    process.stdout.write(`Generated ${file}\n`);
    continue;
  }
  const actual = await fs.readFile(absolute, "utf8").catch(() => "");
  if (actual !== expected) {
    throw new Error(`${file} is out of date. Run npm run config:docs.`);
  }
}

if (!write) process.stdout.write("Configuration docs match the runtime environment manifest.\n");

function renderEnvExample() {
  const lines = [
    "# Generated from src/config/environment.ts. Run npm run config:docs after changing the manifest.",
    "# Stable models, limits, repository identity, and product behavior live in src/config/env.ts.",
    "",
  ];
  for (const group of ["core", "github", "access", "integration", "deployment"] as const) {
    lines.push(`# ${groupTitle(group)}`);
    for (const variable of variables.filter((candidate) => candidate.group === group)) {
      const prefix = variable.operator && group === "core" ? "" : "# ";
      lines.push(`# ${variable.description} Required for: ${variable.requiredFor}.`);
      lines.push(`${prefix}${variable.name}=${variable.example ?? ""}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderConfigurationGuide() {
  const lines = [
    "# Configuration",
    "",
    "> Generated from `src/config/environment.ts`. Run `npm run config:docs` after changing the manifest.",
    "",
    "The environment is reserved for credentials, private deployment identity, and immutable release coordinates. Models, limits, repository identity, queue topology, retention, payment rail, and other product decisions live in versioned `productConfig` in `src/config/env.ts`.",
    "",
    "Production startup rejects retired variables so old deployment settings cannot silently pretend to work. Local shells may still contain them during migration, but the runtime never parses or uses them. Supplying both values for an optional integration enables that capability; incomplete credential pairs leave it unavailable.",
    "",
    "`src/config/environment.ts` is the human-facing manifest and `envSchema` in `src/config/env.ts` is the parser. Startup asserts that their key sets are identical, so adding a runtime variable without documenting it—or documenting a variable the runtime ignores—fails immediately.",
    "",
    "| Variable | Required for | Secret | Purpose |",
    "| --- | --- | --- | --- |",
    ...variables.map((variable) =>
      `| \`${variable.name}\` | ${escapeCell(variable.requiredFor)} | ${variable.secret ? "yes" : "no"} | ${escapeCell(variable.description)} |`
    ),
    "",
    "## Ownership",
    "",
    "- Humans or the secret manager set variables marked for application credentials, GitHub, access policy, and optional integrations.",
    "- Docker/Kubernetes and the deployment workflow inject `NODE_ENV`, revision metadata, namespace, and the immutable sandbox image.",
    "- `.env.example` is generated from the same manifest and is the local-development template.",
    "- `npm run config:check` verifies generated files; `npm run config:docs` rewrites them intentionally.",
    "",
  ];
  return lines.join("\n");
}

function groupTitle(group: EnvironmentVariableGroup) {
  return ({
    core: "Required application credentials and identity",
    github: "GitHub publication (choose token or complete App credentials)",
    access: "Operator access and protected capabilities",
    integration: "Optional integrations (supply complete credential pairs)",
    deployment: "Injected deployment metadata (do not hand-configure locally)",
  } satisfies Record<EnvironmentVariableGroup, string>)[group];
}

function escapeCell(value: string) {
  return value.replaceAll("|", "\\|");
}
