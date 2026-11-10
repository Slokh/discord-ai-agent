import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const SOURCE_LINE_LIMIT = 752;
const TEST_LINE_LIMIT = 3_300;

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
  it("does not override Discord.js onto an incompatible HTTP runtime", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; overrides?: Record<string, string> };
    const lock = JSON.parse(
      await fs.readFile(path.join(process.cwd(), "package-lock.json"), "utf8"),
    ) as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };

    expect(manifest.overrides).not.toHaveProperty("undici");
    expect(manifest.dependencies?.undici).toMatch(/^\^6\./);
    expect(lock.packages["node_modules/discord.js"]?.dependencies?.undici).toMatch(/^\^6\./);
    expect(lock.packages["node_modules/undici"]?.version).toMatch(/^6\./);
  });

  it("keeps production deployment in the main CI check graph", async () => {
    const ci = await fs.readFile(path.join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    const deployment = await fs.readFile(
      path.join(process.cwd(), ".github/workflows/deploy-k3s.yml"),
      "utf8",
    );

    expect(ci).toContain("cancel-in-progress: ${{ github.event_name != 'push' }}");
    expect(ci).toMatch(/deploy-k3s:\n\s+needs: \[changes, verify, publish-images\]/);
    expect(ci).toContain("uses: ./.github/workflows/deploy-k3s.yml");
    expect(ci).toContain("image_tag: ${{ github.sha }}");
    expect(ci).toContain(".github/workflows/ci.yml|.github/workflows/deploy-k3s.yml|Dockerfile");
    expect(deployment).toContain("workflow_call:");
    expect(deployment).toContain("IMAGE_TAG: ${{ inputs.image_tag }}");
    expect(deployment).toContain("aws ssm send-command");
    expect(deployment).not.toContain("aws eks");
    expect(deployment).not.toContain("workflow_run:");
    expect(ci).toContain("$ECR_REPOSITORY:$TREE_TAG");
    expect(ci).not.toContain("$ECR_REPOSITORY-candidate");
  });

  it("keeps the adopted AWS stack bounded to the standalone runtime", async () => {
    const terraform = await Promise.all(
      ["main.tf", "k3s.tf", "backups.tf", "github-oidc.tf"].map((file) =>
        fs.readFile(path.join(process.cwd(), "deploy/terraform/aws", file), "utf8"),
      ),
    ).then((files) => files.join("\n"));

    expect(terraform).toContain('resource "aws_autoscaling_group" "k3s"');
    expect(terraform).toContain("min_size            = 1");
    expect(terraform).toContain("max_size            = 1");
    expect(terraform).toContain("desired_capacity    = 1");
    expect(terraform).toContain("vpc_zone_identifier = [data.aws_subnet.k3s.id]");
    expect(terraform).toContain("volume_size           = 30");
    expect(terraform).toContain("enabled = false");
    expect(terraform).toContain("delete_after = 14");
    expect(terraform).toContain("volume/${var.postgres_volume_id}");
    expect(terraform).toContain("aws_ebs_volume.k3s_state.arn");
    expect(terraform).not.toContain('module "eks"');
    expect(terraform).not.toContain("aws_eks_");
    expect(terraform).not.toContain("aws_db_instance");
    expect(terraform).not.toContain("candidate_sandbox");
    expect(terraform).not.toContain("candidate_repository_subjects");
  });

  it("does not mount Kubernetes API credentials into the shared app service account", async () => {
    const serviceAccounts = await fs.readFile(path.join(process.cwd(), "deploy/helm/discord-ai-agent/templates/serviceaccounts.yaml"), "utf8");
    expect(serviceAccounts.match(/kind: ServiceAccount/g)).toHaveLength(1);
    expect(serviceAccounts.match(/automountServiceAccountToken: false/g)).toHaveLength(1);
    for (const workload of ["bot.yaml", "worker.yaml", "console.yaml"]) {
      const template = await fs.readFile(path.join(process.cwd(), "deploy/helm/discord-ai-agent/templates", workload), "utf8");
      expect(template).toContain('serviceAccountName: {{ include "discord-ai-agent.fullname" . }}-app');
    }
  });

  it("allows the Console to finish cold startup before liveness restarts it", async () => {
    const deployment = await fs.readFile(path.join(process.cwd(), "deploy/helm/discord-ai-agent/templates/console.yaml"), "utf8");
    expect(deployment).toContain("startupProbe:");
    expect(deployment).toMatch(/startupProbe:[\s\S]*periodSeconds: 5[\s\S]*failureThreshold: 24[\s\S]*readinessProbe:/);
  });

  it("keeps the optional Console out of the lightweight production deployment", async () => {
    const consoleDeployment = await fs.readFile(path.join(process.cwd(), "deploy/helm/discord-ai-agent/templates/console.yaml"), "utf8");
    const deploymentWorkflow = await fs.readFile(path.join(process.cwd(), ".github/workflows/deploy-k3s.yml"), "utf8");
    expect(consoleDeployment).toContain("if .Values.console.enabled");
    expect(deploymentWorkflow).not.toContain("CONSOLE_TLS_CERTIFICATE_ARN");
    expect(deploymentWorkflow).not.toContain("console-public");
  });

  it("never changes K3s server token flags", async () => {
    const server = await fs.readFile(path.join(process.cwd(), "deploy/terraform/aws/templates/k3s-user-data.sh.tftpl"), "utf8");
    // Adding a token flag to the existing cluster rewrote cred/passwd, after
    // which K3s refused to start because the file was newer than the datastore.
    const serverUnit = heredoc(server, "/etc/systemd/system/k3s.service");
    expect(serverUnit).not.toMatch(/--(?:agent-)?token/);
    expect(serverUnit).not.toContain("ExecStartPre");
    expect(serverUnit.match(/^\s+--\S+/gm)?.map((flag) => flag.trim())).toEqual([
      "--node-name=discord-ai-agent-production",
      "--node-label=discord-ai-agent.dev/storage=local",
      "--disable=traefik",
      "--disable=servicelb",
      "--disable=local-storage",
      "--disable=metrics-server",
      "--secrets-encryption",
      "--write-kubeconfig-mode=0600",
    ]);
  });

  it("keeps launch-template user data under the EC2 16 KiB raw limit", async () => {
    const terraform = await fs.readFile(path.join(process.cwd(), "deploy/terraform/aws/k3s.tf"), "utf8");
    const server = await fs.readFile(path.join(process.cwd(), "deploy/terraform/aws/templates/k3s-user-data.sh.tftpl"));
    // The server script outgrew 16 KiB, so it ships gzip-compressed. Interpolated
    // ARNs and IDs add well under the remaining headroom.
    expect(terraform).toContain('user_data = base64gzip(templatefile("${path.module}/templates/k3s-user-data.sh.tftpl"');
    expect(gzipSync(server, { level: 9 }).length).toBeLessThan(12_288);
  });

  it("runs every workload under the app identity without Kubernetes write authority", async () => {
    const worker = await fs.readFile(path.join(process.cwd(), "deploy/helm/discord-ai-agent/templates/worker.yaml"), "utf8");
    const verification = await fs.readFile(path.join(process.cwd(), "scripts/deployK3s.sh"), "utf8");
    expect(worker).not.toContain("sandboxLauncherEnv");
    expect(worker).not.toMatch(/serviceAccountName: [^\n]*-worker/);
    expect(verification).toContain('[ "$worker_account" = "$release-app" ]');
    expect(verification).toMatch(/for verb in "create jobs\.batch" "get secrets" "create pods"; do[\s\S]*?--as="system:serviceaccount:\$namespace:\$release-app" \|\| true\)"\n\s+\[ "\$permission" = "no" \]/);
    for (const flag of ["api.enabled", "sandbox.isolation.enabled", "egressProxy.enabled", "networkPolicy.enabled"]) {
      expect(verification).not.toContain(`--set ${flag}=true`);
    }
  });

  it("keeps deployment verification content-free and free of paid canaries", async () => {
    const deployment = await fs.readFile(
      path.join(process.cwd(), ".github/workflows/deploy-k3s.yml"),
      "utf8",
    );
    const verification = await fs.readFile(
      path.join(process.cwd(), "scripts/deployK3s.sh"),
      "utf8",
    );
    expect(deployment).toContain("scripts/deployK3s.sh");
    expect(verification).not.toContain("postDeployCanary");
    expect(verification).not.toContain("--private-only");
    expect(verification).not.toContain("--record-improvement-results");
    expect(verification).toContain("sleep 30");
    expect(verification).toContain("kubectl auth can-i $verb");
    expect(verification).toContain("markReleaseVerified.js");
    expect(deployment).not.toContain("upload-artifact");
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
      "src/agent/runtimeLifecycle.ts",
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
      "runSandboxAgent",
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
    const allowedPrefixes = ["src/config/"];
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

function heredoc(script: string, target: string) {
  const start = script.indexOf(`cat >${target} <<'EOF'\n`);
  if (start < 0) throw new Error(`missing heredoc for ${target}`);
  const end = script.indexOf("\nEOF\n", start);
  return script.slice(start, end);
}
