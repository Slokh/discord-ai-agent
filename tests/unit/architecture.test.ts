import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_LINE_LIMIT = 760;
const TEST_LINE_LIMIT = 3_350;

const requiredArchitectureGuides = [
  "docs/README.md",
  "docs/product.md",
  "docs/architecture.md",
  "docs/configuration.md",
  "docs/agent-system.md",
  "docs/data.md",
  "docs/payments.md",
  "docs/code-updates.md",
  "docs/operations.md",
  "docs/development.md",
];

describe("architecture guardrails", () => {
  it("does not mount Kubernetes API credentials into app or sandbox service accounts", async () => {
    const serviceAccounts = await fs.readFile(path.join(process.cwd(), "deploy/helm/discord-ai-agent/templates/serviceaccounts.yaml"), "utf8");
    expect(serviceAccounts.match(/automountServiceAccountToken: false/g)).toHaveLength(2);
  });

  it("keeps broad sandbox HTTPS egress away from private and metadata networks", async () => {
    const policy = await fs.readFile(path.join(process.cwd(), "deploy/helm/discord-ai-agent/templates/networkpolicy.yaml"), "utf8");
    for (const cidr of ["10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"]) {
      expect(policy).toContain(`- ${cidr}`);
    }
  });

  it("keeps private production regression output out of GitHub artifacts and detailed logs", async () => {
    const scheduled = await fs.readFile(
      path.join(process.cwd(), ".github/workflows/private-regressions.yml"),
      "utf8",
    );
    const deployment = await fs.readFile(
      path.join(process.cwd(), ".github/workflows/deploy-eks.yml"),
      "utf8",
    );
    for (const workflow of [scheduled, deployment]) {
      expect(workflow).toContain("--safe-summary");
      expect(workflow).toContain("--private-only");
    }
    expect(deployment).toContain("scripts/deploymentHealth.ts");
    expect(deployment).toContain("--stability-seconds 30");
    expect(deployment).toContain("--force-conflicts");
    expect(scheduled).not.toContain("upload-artifact");
  });

  it("keeps the post-deploy canary invisible to Discord members", async () => {
    const canary = await fs.readFile(path.join(process.cwd(), "scripts/postDeployCanary.ts"), "utf8");
    expect(canary).toContain('discordRequest<{ id: string; bot?: boolean }>("/users/@me"');
    expect(canary).toContain('discordRequest<{ id: string; guild_id?: string }>(`/channels/${channelId}`');
    expect(canary).not.toContain("message_reference");
    expect(canary).not.toContain("Post-deploy delivery canary source");
  });

  it("keeps consolidated architecture guides present", async () => {
    for (const readme of requiredArchitectureGuides) {
      await expect(
        fs.stat(path.join(process.cwd(), readme)),
      ).resolves.toMatchObject({ isFile: expect.any(Function) });
    }
  });

  it("prevents oversized source files", async () => {
    const sourceFiles = await listSourceFiles(path.join(process.cwd(), "src"));
    const oversized: Array<{ file: string; lines: number }> = [];

    for (const file of sourceFiles) {
      const relative = normalizePath(path.relative(process.cwd(), file));
      const content = await fs.readFile(file, "utf8");
      const lines = content.split(/\r?\n/).length;
      if (lines > SOURCE_LINE_LIMIT) oversized.push({ file: relative, lines });
    }

    expect(oversized).toEqual([]);
  });

  it("prevents test suites from becoming unbounded repositories of unrelated behavior", async () => {
    const testFiles = await listSourceFiles(path.join(process.cwd(), "tests"));
    const oversized: Array<{ file: string; lines: number }> = [];
    for (const file of testFiles) {
      const content = await fs.readFile(file, "utf8");
      const lines = content.split(/\r?\n/).length;
      if (lines > TEST_LINE_LIMIT) {
        oversized.push({
          file: normalizePath(path.relative(process.cwd(), file)),
          lines,
        });
      }
    }
    expect(oversized).toEqual([]);
  });

  it("keeps product capabilities out of the generic agent loop", async () => {
    const genericFiles = [
      "src/agent/capabilityRuntime.ts",
      "src/agent/nanocodexAgentRuntime.ts",
      "src/agent/promptBuilder.ts",
      "src/agent/runtimeControlPlane.ts",
      "src/agent/toolDispatcher.ts",
      "src/tools/toolDeployment.ts",
      "src/tools/toolScope.ts",
    ];
    const featureNames = [
      "addDiscordReaction",
      "composeDiscordResponse",
      "drawRandom",
      "generateImage",
      "inspectDiscordImages",
      "runCodingAgent",
      "setAgentModel",
      "settleRandomWager",
      "Spotify",
      "transferWalletFunds",
    ];

    for (const file of genericFiles) {
      const content = await fs.readFile(path.join(process.cwd(), file), "utf8");
      for (const featureName of featureNames) {
        expect(content, `${file} should not know capability ${featureName}`).not.toContain(featureName);
      }
    }
    await expect(fs.stat(path.join(process.cwd(), "src/agent/toolHandlers"))).rejects.toThrow();

    const agentFiles = await listSourceFiles(path.join(process.cwd(), "src/agent"));
    const forbiddenFeatureImports = [
      '"../payments/',
      '"../execution/',
      '"../tools/agentModelTools',
      '"../tools/agentTaskTools',
      '"../tools/imageTools',
      '"../tools/randomTools',
      '"../tools/spotifyTools',
      '"../tools/walletTools',
    ];
    for (const file of agentFiles) {
      const content = await fs.readFile(file, "utf8");
      for (const importPath of forbiddenFeatureImports) {
        expect(content, `${path.relative(process.cwd(), file)} should not import ${importPath}`).not.toContain(importPath);
      }
    }
  });

  it("keeps tool contracts independent from execution handlers", async () => {
    const contractFiles = await listSourceFiles(
      path.join(process.cwd(), "src/tools/contracts"),
    );
    for (const file of contractFiles) {
      const content = await fs.readFile(file, "utf8");
      expect(
        content,
        `${normalizePath(path.relative(process.cwd(), file))} must not import handlers`,
      ).not.toMatch(/from\s+["'][^"']*handlers(?:\/|["'])/);
    }
  });

  it("centralizes production environment access", async () => {
    const sourceFiles = await listSourceFiles(path.join(process.cwd(), "src"));
    const allowedPrefixes = ["src/config/", "src/execution/"];
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const relative = normalizePath(path.relative(process.cwd(), file));
      if (allowedPrefixes.some((prefix) => relative.startsWith(prefix))) continue;
      const content = await fs.readFile(file, "utf8");
      if (/\bprocess\.env\b/.test(content)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it("uses one installed capability composition root", async () => {
    const catalog = await fs.readFile(path.join(process.cwd(), "src/capabilities/catalog.ts"), "utf8");
    expect(catalog).toContain("installedCapabilities");
    expect(catalog).toContain("installedToolContracts");
    expect(catalog).toContain("installedToolHandlers");
    const registry = await fs.readFile(path.join(process.cwd(), "src/tools/registry.ts"), "utf8");
    expect(registry).toContain("capabilities/toolContracts");
    expect(registry).not.toContain("contracts/index");
  });

  it("uses the shared application-service composition root in every prompt runtime", async () => {
    const promptRuntime = await fs.readFile(path.join(process.cwd(), "scripts/prompt.ts"), "utf8");
    const productionRuntime = await fs.readFile(path.join(process.cwd(), "src/index.ts"), "utf8");
    expect(promptRuntime).toContain('import("../src/runtime/applicationServices.js")');
    expect(productionRuntime).toContain('from "./runtime/applicationServices.js"');
    expect(promptRuntime).not.toContain('import("../src/db/rngRepository.js")');
    expect(promptRuntime).toMatch(/rng:\s*rngRepo/);
    expect(promptRuntime).toMatch(/toolContext:\s*\{[\s\S]*?\brngRepo,/);
  });

  it("keeps relative source imports acyclic", async () => {
    const sourceFiles = await listSourceFiles(path.join(process.cwd(), "src"));
    const knownFiles = new Set(sourceFiles.map((file) => path.resolve(file)));
    const graph = new Map<string, string[]>();

    for (const file of sourceFiles) {
      const content = await fs.readFile(file, "utf8");
      const dependencies = [
        ...content.matchAll(
          /(?:import|export)\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?["'](\.[^"']+)["']/g,
        ),
      ]
        .map((match) => resolveSourceImport(file, match[1] ?? "", knownFiles))
        .filter((dependency): dependency is string => dependency != null);
      graph.set(path.resolve(file), dependencies);
    }

    expect(
      findImportCycle(graph)?.map((file) =>
        normalizePath(path.relative(process.cwd(), file)),
      ) ?? [],
    ).toEqual([]);
  });
});

function resolveSourceImport(
  importer: string,
  specifier: string,
  knownFiles: Set<string>,
) {
  const unresolved = path.resolve(path.dirname(importer), specifier);
  const candidates = /\.js$/.test(unresolved)
    ? [unresolved.replace(/\.js$/, ".ts"), unresolved.replace(/\.js$/, ".tsx")]
    : [
        unresolved,
        `${unresolved}.ts`,
        `${unresolved}.tsx`,
        path.join(unresolved, "index.ts"),
      ];
  return candidates.find((candidate) => knownFiles.has(candidate)) ?? null;
}

function findImportCycle(graph: Map<string, string[]>) {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const visit = (file: string): string[] | null => {
    if (active.has(file)) return [...stack.slice(stack.indexOf(file)), file];
    if (visited.has(file)) return null;
    visited.add(file);
    active.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(file);
    return null;
  };
  for (const file of graph.keys()) {
    const cycle = visit(file);
    if (cycle) return cycle;
  }
  return null;
}

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name))
      files.push(fullPath);
  }
  return files;
}

function normalizePath(value: string) {
  return value.split(path.sep).join("/");
}
