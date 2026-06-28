import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMigrationsDir } from "../../src/db/migrate.js";

describe("resolveMigrationsDir", () => {
  it("resolves migrations from the runtime working directory", () => {
    expect(resolveMigrationsDir("/app")).toBe(path.join("/app", "migrations"));
  });
});
