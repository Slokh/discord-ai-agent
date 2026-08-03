import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IsolatedTestDatabase } from "./testDatabase.js";
import { createIsolatedTestDatabase } from "./testDatabase.js";
import { collectRevisionQuality } from "../../src/observability/revisionQuality.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("revision quality database contract", () => {
  let database: IsolatedTestDatabase;

  beforeAll(async () => {
    database = await createIsolatedTestDatabase("revision_quality");
  });

  afterAll(async () => {
    await database.cleanup();
  });

  it("queries every aggregate against the migrated production schema", async () => {
    await expect(collectRevisionQuality(database.pool, "test-revision", 48)).resolves.toMatchObject({
      revision: "test-revision",
      windowHours: 48,
      answers: [],
      tools: [],
      signals: [],
      deliveries: [],
    });
  });
});
