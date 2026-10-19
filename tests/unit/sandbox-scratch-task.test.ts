import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptsCleanNanoCodexResult, defaultNanoCodexInstructions } from "../../src/execution/harness/nanocodex.js";
import { downloadToDirectory, fileNameFromResponse, resolveDirectDownloadUrl, sanitizeFileName } from "../../src/execution/sandboxFetch.js";
import { AGENT_TASK_TYPES, parseAgentTaskType, sandboxProfileForTaskType } from "../../src/execution/sandboxProfiles.js";
import type { SandboxEnv } from "../../src/execution/sandboxEnv.js";
import { writeSandboxToolShims } from "../../src/execution/sandboxToolShims.js";

vi.mock("../../src/execution/callbacks.js", () => ({
  progress: vi.fn(async () => undefined),
  recordResultFile: vi.fn(async () => undefined),
}));

const { uploadDeliveredFiles } = await import("../../src/execution/scratchTask.js");

let tempDir: string;
beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-scratch-"));
});
afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("sandbox profiles", () => {
  it("gives every task type exactly one profile and rejects unknown types", () => {
    for (const taskType of AGENT_TASK_TYPES) expect(sandboxProfileForTaskType(taskType)).toBeDefined();
    expect(parseAgentTaskType("computer_task")).toBe("computer_task");
    expect(parseAgentTaskType("rm -rf")).toBeNull();
  });

  it("runs computer tasks in a scratch workspace without repository credentials", () => {
    const computer = sandboxProfileForTaskType("computer_task");
    expect(computer).toMatchObject({ workspace: "scratch", publishesPullRequest: false, deliversResultToRequester: true });
    expect(computer.credentials).toEqual(["openrouter"]);
    expect(computer.capabilities).toMatchObject({ desktop: true, fileDownload: true });
    expect(sandboxProfileForTaskType("code_update").credentials).toContain("github");
  });

  it("accepts a clean answer only for result-profile tasks", () => {
    expect(acceptsCleanNanoCodexResult("computer_task", 0, "Won the first round.")).toBe(true);
    expect(acceptsCleanNanoCodexResult("diagnosis", 0, "CI cache misses.")).toBe(true);
    expect(acceptsCleanNanoCodexResult("code_update", 0, "Looks fine.")).toBe(false);
    expect(acceptsCleanNanoCodexResult("computer_task", 1, "partial")).toBe(false);
    expect(defaultNanoCodexInstructions("computer_task")).toContain("disposable, isolated computer");
  });
});

describe("computer profile helper commands", () => {
  it("installs fetch, desktop, and deliver helpers without repository cache tools", async () => {
    const env = { taskType: "computer_task", sandboxCacheDir: "/cache" } as SandboxEnv;
    const shims = await writeSandboxToolShims(path.join(tempDir, "shims"), env, {
      workspaceDir: path.join(tempDir, "workspace"),
      deliverDir: path.join(tempDir, "deliver"),
      fetchScript: "/app/dist/src/execution/sandboxFetch.js",
    });
    expect(shims.sort()).toEqual(["agent-deliver", "agent-desktop", "agent-fetch", "agent-task-context"]);
    const desktop = await fs.readFile(path.join(tempDir, "shims", "agent-desktop"), "utf8");
    expect(desktop).toContain("export DISPLAY=':99'");
    expect(desktop).toContain("set -- wine \"$@\"");
    expect(desktop).toContain("import -window root");
  });

  it("delivers at most four files and refuses more", async () => {
    const env = { taskType: "computer_task", sandboxCacheDir: "/cache" } as SandboxEnv;
    const shimDir = path.join(tempDir, "shims");
    const deliverDir = path.join(tempDir, "deliver");
    await writeSandboxToolShims(shimDir, env, { workspaceDir: tempDir, deliverDir });
    const { execFile } = await import("node:child_process");
    const run = (args: string[]) => new Promise<{ code: number }>((resolve) => {
      execFile(path.join(shimDir, "agent-deliver"), args, (error) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0 }));
    });
    for (let index = 0; index < 5; index += 1) await fs.writeFile(path.join(tempDir, `shot-${index}.png`), "png");
    for (let index = 0; index < 4; index += 1) expect((await run([path.join(tempDir, `shot-${index}.png`)])).code).toBe(0);
    expect((await run([path.join(tempDir, "shot-4.png")])).code).not.toBe(0);
    expect((await fs.readdir(deliverDir)).sort()).toEqual(["00-shot-0.png", "01-shot-1.png", "02-shot-2.png", "03-shot-3.png"]);
  });

  it("uploads delivered files in order and skips unsupported types", async () => {
    const deliverDir = path.join(tempDir, "deliver");
    await fs.mkdir(deliverDir);
    await fs.writeFile(path.join(deliverDir, "01-notes.exe"), "MZ");
    await fs.writeFile(path.join(deliverDir, "00-final.png"), "png-bytes");
    const upload = vi.fn(async () => undefined);
    const delivered = await uploadDeliveredFiles({ taskId: "task-1" } as SandboxEnv, deliverDir, upload);
    expect(delivered).toBe(1);
    expect(upload).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: "final.png", contentType: "image/png", order: 0 }));
  });
});

describe("agent-fetch", () => {
  it("rewrites common share links to direct downloads", () => {
    expect(resolveDirectDownloadUrl("https://drive.google.com/file/d/FILE_id-0123456789/view?usp=sharing"))
      .toBe("https://drive.usercontent.google.com/download?id=FILE_id-0123456789&export=download&confirm=t");
    expect(resolveDirectDownloadUrl("https://drive.google.com/open?id=abc_123")).toContain("id=abc_123");
    expect(resolveDirectDownloadUrl("https://www.dropbox.com/s/xyz/game.zip?dl=0")).toBe("https://www.dropbox.com/s/xyz/game.zip?dl=1");
    expect(resolveDirectDownloadUrl("https://github.com/o/r/blob/main/dist/game.zip")).toBe("https://github.com/o/r/raw/main/dist/game.zip");
    expect(resolveDirectDownloadUrl("https://example.com/game.zip")).toBe("https://example.com/game.zip");
    expect(() => resolveDirectDownloadUrl("file:///etc/passwd")).toThrow(/http/);
  });

  it("names files safely from headers or the URL", () => {
    const response = (headers: Record<string, string>, url = "https://x.test/path/a.zip") => ({ headers: new Headers(headers), url });
    expect(fileNameFromResponse(response({ "content-disposition": "attachment; filename=\"Example Game.zip\"" }), "")).toBe("Example Game.zip");
    expect(fileNameFromResponse(response({ "content-disposition": "attachment; filename*=UTF-8''..%2F..%2Fevil.exe" }), "")).toBe("evil.exe");
    expect(fileNameFromResponse(response({}), "")).toBe("a.zip");
    expect(sanitizeFileName("..")).toBe("download");
  });

  it("streams to disk and enforces the size cap", async () => {
    const body = (text: string) => new Response(text, { headers: { "content-type": "application/zip" } });
    const ok = await downloadToDirectory({ url: "https://x.test/game.zip", directory: tempDir, fetchImpl: async () => body("zip-bytes") });
    expect(ok).toMatchObject({ bytes: 9, contentType: "application/zip" });
    expect(await fs.readFile(ok.path, "utf8")).toBe("zip-bytes");
    await expect(downloadToDirectory({ url: "https://x.test/big.zip", directory: tempDir, maxBytes: 4, fetchImpl: async () => body("too-large") }))
      .rejects.toThrow(/limit/);
  });

  it("reports a share page instead of saving HTML as the file", async () => {
    await expect(downloadToDirectory({
      url: "https://drive.google.com/file/d/abc/view",
      directory: tempDir,
      fetchImpl: async () => new Response("<html>", { headers: { "content-type": "text/html" } }),
    })).rejects.toThrow(/web page instead of the file/);
  });
});
