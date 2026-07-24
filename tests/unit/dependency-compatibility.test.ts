import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type PackageManifest = {
  dependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  version?: string;
};

const require = createRequire(import.meta.url);

describe("dependency compatibility", () => {
  it("keeps Undici on the major supported by Discord.js REST", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    ) as PackageManifest;
    const installedUndici = require("undici/package.json") as PackageManifest;

    expect(manifest.dependencies?.undici).toBe("6.27.0");
    expect(manifest.overrides?.undici).toBe("6.27.0");
    expect(installedUndici.version).toMatch(/^6\./);
  });
});
