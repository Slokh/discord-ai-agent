import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_LINE_LIMIT = 800;

const legacyLargeFiles = new Map<string, string>([
  ["src/control/console/App.tsx", "Compatibility shell for the run console while view modules are extracted."],
  ["src/control/taskTerminalUi.ts", "Legacy terminal UI renderer pending extraction or replacement by the run console."],
  ["src/control/internalApi.ts", "Compatibility internal API entrypoint while route handlers are extracted."],
  ["src/tools/registry.ts", "Current single registry pending schema-family extraction."],
  ["src/db/codegenRepository.ts", "Legacy durable codegen session repository pending merge into domain repository modules."],
  ["src/observability/runs.ts", "Compatibility run-console adapter while process-run and runtime-ledger projections are split into modules."]
]);

const requiredDomainReadmes = [
  "src/README.md",
  "src/agent/README.md",
  "src/control/README.md",
  "src/control/console/README.md",
  "src/db/README.md",
  "src/discord/README.md",
  "src/execution/README.md",
  "src/tools/README.md"
];

describe("architecture guardrails", () => {
  it("keeps source-domain navigation docs present", async () => {
    for (const readme of requiredDomainReadmes) {
      await expect(fs.stat(path.join(process.cwd(), readme))).resolves.toMatchObject({ isFile: expect.any(Function) });
    }
  });

  it("prevents new oversized source files without an explicit migration allowance", async () => {
    const sourceFiles = await listSourceFiles(path.join(process.cwd(), "src"));
    const oversized: Array<{ file: string; lines: number }> = [];

    for (const file of sourceFiles) {
      const relative = normalizePath(path.relative(process.cwd(), file));
      const content = await fs.readFile(file, "utf8");
      const lines = content.split(/\r?\n/).length;
      if (lines > SOURCE_LINE_LIMIT && !legacyLargeFiles.has(relative)) oversized.push({ file: relative, lines });
    }

    expect(oversized).toEqual([]);
  });

  it("keeps every large-file allowance documented with a migration reason", () => {
    for (const [file, reason] of legacyLargeFiles) {
      expect(file).toMatch(/^src\/.+\.(?:ts|tsx)$/);
      expect(reason.length).toBeGreaterThan(30);
    }
  });
});

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}

function normalizePath(value: string) {
  return value.split(path.sep).join("/");
}
