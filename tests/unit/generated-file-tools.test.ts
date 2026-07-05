import { describe, expect, it, vi } from "vitest";
import { queryGeneratedCsv, readGeneratedFile } from "../../src/tools/generatedFileTools.js";
import type { ToolContext } from "../../src/tools/types.js";

function fakeContext(): ToolContext {
  return {
    config: { maxReplyChars: 1800 } as unknown as ToolContext["config"],
    repo: { auditTool: vi.fn(async () => undefined) } as unknown as ToolContext["repo"],
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    userDisplayName: "User",
    visibleChannelIds: [],
    generatedFiles: [
      {
        name: "playlist.csv",
        contentType: "text/csv",
        data: Buffer.from(
          [
            '"position","track","artists","album","duration","explicit","local","added_at","spotify_url"',
            '"1","Old Song","Old Artist","Old Album","3:00","false","false","2024-01-01","https://example.test/old"',
            '"2","New Song","Radiohead, Thom Yorke","Kid A","4:00","false","false","2025-08-01","https://example.test/new"',
            '"3","Another New Song","Radiohead","Kid A","5:00","false","false","2025-09-01","https://example.test/new2"',
            '"4","Other New Song","Kate Bush","Hounds of Love","3:30","false","false","2025-10-01","https://example.test/new3"'
          ].join("\n"),
          "utf8"
        )
      },
      {
        name: "notes.txt",
        contentType: "text/plain",
        data: Buffer.from("hello generated file", "utf8")
      }
    ]
  } as unknown as ToolContext;
}

describe("generated file tools", () => {
  it("reads bounded chunks from generated files", async () => {
    const result = await readGeneratedFile(fakeContext(), { fileName: "notes.txt", maxBytes: 5 });

    expect(result.content).toContain("Generated file: notes.txt");
    expect(result.content).toContain("Range: 0-5");
    expect(result.content).toContain("hello");
  });

  it("profiles generated CSV files", async () => {
    const result = await queryGeneratedCsv(fakeContext(), { fileName: "playlist.csv", operation: "profile" });

    expect(result.content).toContain("Generated CSV profile: playlist.csv");
    expect(result.content).toContain("Rows: 4");
    expect(result.content).toContain("Headers: position, track, artists");
  });

  it("infers the only generated CSV when other generated files exist", async () => {
    const result = await queryGeneratedCsv(fakeContext(), { operation: "profile" });

    expect(result.content).toContain("Generated CSV profile: playlist.csv");
    expect(result.content).toContain("Rows: 4");
  });

  it("tells the model how to recover when a generated file is not CSV", async () => {
    const result = await queryGeneratedCsv(fakeContext(), { fileName: "notes.txt", operation: "profile" });

    expect(result.content).toContain("is not a CSV file");
    expect(result.content).toContain("call the tool that produced it again with a CSV output format");
    expect(result.content).toContain("then call queryGeneratedCsv");
  });

  it("filters and ranks split CSV values", async () => {
    const result = await queryGeneratedCsv(fakeContext(), {
      fileName: "playlist.csv",
      operation: "topValues",
      column: "artists",
      filters: [{ column: "added_at", op: "gte", value: "2025-07-05" }],
      splitValues: true,
      limit: 3
    });

    expect(result.content).toContain("Generated CSV top values: playlist.csv");
    expect(result.content).toContain("Filters: added_at gte \"2025-07-05\"");
    expect(result.content).toContain("Rows matched: 3");
    expect(result.content).toContain("1. Radiohead (2)");
    expect(result.content).toContain("2. Kate Bush (1)");
    expect(result.content).toContain("3. Thom Yorke (1)");
    expect(result.content).not.toContain("Old Artist");
  });

  it("returns filtered rows with selected columns", async () => {
    const result = await queryGeneratedCsv(fakeContext(), {
      fileName: "playlist.csv",
      operation: "filterRows",
      filters: [{ column: "artists", op: "contains", value: "Radiohead" }],
      selectColumns: ["track", "artists", "added_at"],
      limit: 1
    });

    expect(result.content).toContain("Rows matched: 2");
    expect(result.content).toContain("track | artists | added_at");
    expect(result.content).toContain("New Song | Radiohead, Thom Yorke | 2025-08-01");
  });
});
