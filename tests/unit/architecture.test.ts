import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_LINE_LIMIT = 800;

const requiredDomainReadmes = [
  "src/README.md",
  "src/agent/README.md",
  "src/control/README.md",
  "src/control/console/README.md",
  "src/db/README.md",
  "src/discord/README.md",
  "src/execution/README.md",
  "src/tools/README.md",
];

describe("architecture guardrails", () => {
  it("keeps source-domain navigation docs present", async () => {
    for (const readme of requiredDomainReadmes) {
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
