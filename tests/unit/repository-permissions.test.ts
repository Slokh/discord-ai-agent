import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("permission-aware retrieval SQL", () => {
  it("includes parent-visible public threads but not parent-visible private threads", () => {
    const source = fs.readFileSync(path.resolve("src/db/repositories.ts"), "utf8");
    expect(source).toContain("c.parent_id = ANY($2::text[]) AND c.type IN (10, 11)");
    expect(source).not.toContain("c.parent_id = ANY($2::text[]))");
  });
});
