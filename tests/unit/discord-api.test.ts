import { describe, expect, it, vi } from "vitest";
import { classifyDiscordWriteError, discordWrite } from "../../src/discord/api.js";

const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as any;

describe("Discord write API", () => {
  it("classifies Unknown Message", () => {
    expect(classifyDiscordWriteError({ code: 10008 })).toBe("unknown_message");
  });

  it("returns missing access as a structured failure", async () => {
    const result = await discordWrite(async () => { throw { code: 50001 }; }, { logger }, "edit");
    expect(result).toMatchObject({ ok: false, reason: "missing_access" });
  });

  it("respects retry_after for 429s", async () => {
    const sleep = vi.fn(async () => undefined);
    const op = vi.fn(async () => {
      if (op.mock.calls.length === 1) throw { status: 429, retry_after: 0.25 };
      return "ok";
    });
    const result = await discordWrite(op, { logger, sleep, retries: 1, maxDelayMs: 5_000 }, "send");
    expect(result).toEqual({ ok: true, value: "ok" });
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("returns success", async () => {
    await expect(discordWrite(async () => 42, { logger })).resolves.toEqual({ ok: true, value: 42 });
  });
});
