import { describe, expect, it, vi } from "vitest";
import { queryGeneratedCsv, queryGeneratedTable, readGeneratedFile } from "../../src/tools/generatedFileTools.js";
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
    ],
    generatedTables: [
      {
        name: "playlist",
        sourceFileName: "playlist.csv",
        columns: ["position", "track", "artists", "album", "duration", "explicit", "local", "added_at", "spotify_url"],
        rows: [
          {
            position: 1,
            track: "Old Song",
            artists: "Old Artist",
            album: "Old Album",
            duration: "3:00",
            explicit: false,
            local: false,
            added_at: "2024-01-01",
            spotify_url: "https://example.test/old"
          },
          {
            position: 2,
            track: "New Song",
            artists: "Radiohead, Thom Yorke",
            album: "Kid A",
            duration: "4:00",
            explicit: false,
            local: false,
            added_at: "2025-08-01",
            spotify_url: "https://example.test/new"
          },
          {
            position: 3,
            track: "Another New Song",
            artists: "Radiohead",
            album: "Kid A",
            duration: "5:00",
            explicit: false,
            local: false,
            added_at: "2025-09-01",
            spotify_url: "https://example.test/new2"
          },
          {
            position: 4,
            track: "Other New Song",
            artists: "Kate Bush",
            album: "Hounds of Love",
            duration: "3:30",
            explicit: false,
            local: false,
            added_at: "2025-10-01",
            spotify_url: "https://example.test/new3"
          }
        ]
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

  it("queries generated table artifacts without reading a CSV file", async () => {
    const result = await queryGeneratedTable(fakeContext(), {
      tableName: "playlist",
      operation: "topValues",
      column: "artists",
      filters: [{ column: "added_at", op: "gte", value: "2025-07-05" }],
      splitValues: true,
      limit: 3
    });

    expect(result.content).toContain("Generated table top values: playlist");
    expect(result.content).toContain("Rows matched: 3");
    expect(result.content).toContain("1. Radiohead (2)");
    expect(result.content).toContain("2. Kate Bush (1)");
    expect(result.content).toContain("3. Thom Yorke (1)");
  });

  it("points CSV queries at generated tables when no CSV file exists", async () => {
    const ctx = fakeContext();
    ctx.generatedFiles = [
      ...(ctx.generatedFiles?.filter((file) => file.name === "notes.txt") ?? []),
      {
        name: "summary.txt",
        contentType: "text/plain",
        data: Buffer.from("another generated text file", "utf8")
      }
    ];

    const result = await queryGeneratedCsv(ctx, { operation: "profile" });

    expect(result.content).toContain("No generated CSV files are available yet.");
    expect(result.content).toContain("Available generated tables for queryGeneratedTable:");
    expect(result.content).toContain("playlist (4 rows");
  });
});
