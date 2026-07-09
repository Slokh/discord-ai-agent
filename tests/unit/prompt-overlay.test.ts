import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPromptOverlayCache, loadPromptOverlayText } from "../../src/agent/promptOverlay.js";

describe("loadPromptOverlayText", () => {
  let dir: string;

  beforeEach(async () => {
    clearPromptOverlayCache();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-overlay-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns undefined when the overlay file does not exist", async () => {
    expect(await loadPromptOverlayText(path.join(dir, "missing.md"))).toBeUndefined();
  });

  it("returns undefined for a blank path or blank file", async () => {
    expect(await loadPromptOverlayText("   ")).toBeUndefined();
    const file = path.join(dir, "blank.md");
    await fs.writeFile(file, "   \n\n");
    expect(await loadPromptOverlayText(file)).toBeUndefined();
  });

  it("returns trimmed overlay content when the file exists", async () => {
    const file = path.join(dir, "prompt-overlay.md");
    await fs.writeFile(file, "\nSpeak like a pirate.\n");
    expect(await loadPromptOverlayText(file)).toBe("Speak like a pirate.");
  });

  it("picks up file changes without a restart", async () => {
    const file = path.join(dir, "prompt-overlay.md");
    await fs.writeFile(file, "First persona.");
    expect(await loadPromptOverlayText(file)).toBe("First persona.");
    await fs.writeFile(file, "Second persona with different length.");
    expect(await loadPromptOverlayText(file)).toBe("Second persona with different length.");
  });

  it("returns undefined again after the file is deleted", async () => {
    const file = path.join(dir, "prompt-overlay.md");
    await fs.writeFile(file, "Temporary persona.");
    expect(await loadPromptOverlayText(file)).toBe("Temporary persona.");
    await fs.rm(file);
    expect(await loadPromptOverlayText(file)).toBeUndefined();
  });
});
