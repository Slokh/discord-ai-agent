import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Finding = {
  file: string;
  label: string;
};

const deniedTerms = [
  deny("legacy project name", ["cool", "mind"]),
  deny("private repo shorthand", ["slokh", "/", "ai"]),
  deny("private repo name", ["slokh", "/", "cool", "mind"]),
  deny("private guild id", ["870030", "475316", "51072"]),
  deny("private owner id", ["870024", "476874", "67008"]),
  deny("private owner id", ["316647", "885259", "276299"]),
  deny("private bot application id", ["152049", "516666", "8931242"]),
  deny("private test guild id", ["152049", "685600", "8753395"]),
  deny("private Railway project id", ["f618", "5373", "-1998", "-4e1f", "-8fba", "-311eead63b0f"]),
  deny("private blocked user id", ["230801", "712691", "019777"]),
  deny("private member handle", ["hunter", "1323"]),
  deny("private member handle", ["sergeant", "gnome"]),
  deny("private member handle", ["no", "idid"]),
  deny("private member handle", ["two", "seven2"]),
  deny("private member handle", ["brave", "_pony", "_66639"]),
  deny("private channel name", ["mind", "cool"]),
  deny("private alias", ["connor", "phones"]),
  deny("private phrase", ["Diar", "beetus"])
];

const secretPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/ },
  { label: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { label: "OpenRouter key", pattern: /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/ },
  { label: "Discord token", pattern: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/ },
  { label: "Railway public proxy host", pattern: /\bproxy\.rlwy\.net\b/i }
];

async function main() {
  const files = await trackedFiles();
  const findings: Finding[] = [];

  for (const file of files) {
    const content = await fs.readFile(file, "utf8").catch(() => undefined);
    if (content == null) continue;
    const lower = content.toLowerCase();
    for (const item of deniedTerms) {
      if (lower.includes(item.term.toLowerCase())) findings.push({ file, label: item.label });
    }
    for (const item of secretPatterns) {
      if (item.pattern.test(content)) findings.push({ file, label: item.label });
    }
  }

  if (findings.length > 0) {
    process.stderr.write("Release scan failed:\n");
    for (const finding of findings) {
      process.stderr.write(`- ${finding.file}: ${finding.label}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`Release scan passed across ${files.length} tracked files.\n`);
}

function deny(label: string, pieces: string[]) {
  return { label, term: pieces.join("") };
}

async function trackedFiles() {
  const { stdout } = await execFileAsync("git", ["ls-files"], { maxBuffer: 1024 * 1024 });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !file.startsWith("node_modules/") && !file.startsWith("dist/"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
