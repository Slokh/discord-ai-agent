import { describe, expect, it } from "vitest";
import { inspectFileBytes } from "../../src/tools/fileInspection.js";

describe("inspectFileBytes", () => {
  it("decodes and normalizes textual files", () => {
    const result = inspectFileBytes({
      data: Buffer.from('{"answer":42,"ok":true}'),
      filename: "result.json",
      declaredContentType: "application/octet-stream"
    });

    expect(result.parser).toBe("text");
    expect(result.detectedType).toBe("application/json");
    expect(result.extractedText).toContain('  "answer": 42');
  });

  it("extracts embedded notes from an iRacing .sto container without inventing setup values", () => {
    const notes = Buffer.from("===Brake Bias===\nMove balance forwards or rearwards.\0", "utf16le");
    const opaquePayload = Buffer.alloc(16, 0xab);
    const integrity = Buffer.alloc(32, 0xcd);
    const trailing = Buffer.alloc(8);
    const body = Buffer.concat([opaquePayload, integrity, notes, trailing]);
    const header = Buffer.alloc(16);
    header.writeUInt32LE(3, 0);
    header.writeUInt32LE(body.length, 4);
    header.writeUInt32LE(opaquePayload.length, 8);
    header.writeUInt32LE(notes.length, 12);

    const result = inspectFileBytes({ data: Buffer.concat([header, body]), filename: "mustang_wet_q.sto" });

    expect(result.parser).toBe("iracing-sto-v3");
    expect(result.detectedType).toBe("application/vnd.iracing.setup");
    expect(result.extractedText).toContain("[BRAKE BIAS]");
    expect(result.metadata).toMatchObject({
      containerVersion: 3,
      opaqueSetupBytes: 16,
      notesBytes: notes.length,
      notesSectionCount: 1,
      notesSections: "Brake Bias",
      setupPurposeFromFilename: "qualifying (inferred from filename)",
      weatherFromFilename: "wet (inferred from filename)",
      semanticSetupValuesDecoded: false
    });
    expect(result.summary).toContain("individual garage values are not decoded");
  });

  it("decodes exact garage values from an iRacing simulator HTML export", () => {
    const html = `<!doctype html>
      <html><head>
        <title>iRacing.com Motorsport Simulations Car Setup</title>
        <meta name="GENERATOR" content="iRacing.com Simulator">
      </head><body>
        <h2 align="center">iRacing.com Motorsport Simulations<br>
        ford mustang gt4 setup: &lt;race&gt;<br>track: daytona road</h2><br>
        <h2><u>LEFT FRONT:</u></h2>
        Starting pressure: <u>21.0 psi</u><br>
        Last temps O M I: <u>120F</u><br><u>122F</u><br><u>124F</u><br>
        Tread remaining: <u>99%</u><br><u>98%</u><br><u>97%</u><br><br>
        <h2><u>FRONT:</u></h2>
        Brake pressure bias: <u>54.2%</u><br>ARB setting: <u>3</u><br><br>
        <h2><u>NOTES:</u></h2>Race setup notes<br>Keep an eye on tire temperatures.<br>
      </body></html>`;

    const result = inspectFileBytes({ data: Buffer.from(html, "latin1"), filename: "mustang-race.html" });

    expect(result.parser).toBe("iracing-garage-html");
    expect(result.detectedType).toBe("application/vnd.iracing.setup-export+html");
    expect(result.summary).toContain("5 exact garage properties");
    expect(result.extractedText).toContain("Car: ford mustang gt4");
    expect(result.extractedText).toContain("[LEFT FRONT TIRE]");
    expect(result.extractedText).toContain("Last temps O M I: 120F | 122F | 124F");
    expect(result.extractedText).toContain("Brake pressure bias: 54.2%");
    expect(result.extractedText).toContain("[NOTES]");
    expect(result.metadata).toMatchObject({
      track: "daytona road",
      setupName: "race",
      setupSections: 2,
      setupProperties: 5,
      semanticSetupValuesDecoded: true
    });
  });

  it("extracts text from a bounded DOCX-compatible ZIP container", () => {
    const documentXml = '<w:document><w:body><w:p><w:r><w:t>Hello &amp; goodbye</w:t></w:r></w:p></w:body></w:document>';
    const zip = storedZip("word/document.xml", Buffer.from(documentXml));

    const result = inspectFileBytes({ data: zip, filename: "notes.docx" });

    expect(result.parser).toBe("office-docx");
    expect(result.extractedText).toContain("Hello & goodbye");
  });

  it("falls back to bounded metadata for unknown binary files", () => {
    const result = inspectFileBytes({
      data: Buffer.from([0xff, 0x00, 0x81, 0x02, 0xfe, 0x03, 0x90, 0x04]),
      filename: "unknown.bin"
    });

    expect(result.parser).toBe("binary-metadata");
    expect(result.extractedText).toBeNull();
    expect(result.metadata.first32Hex).toBe("ff008102fe039004");
  });

  it("keeps invalid numeric HTML entities inert", () => {
    const html = `<!doctype html><title>iRacing.com Motorsport Simulations Car Setup</title>
      <meta name="GENERATOR" content="iRacing.com Simulator">
      <h2 align="center">iRacing.com Motorsport Simulations<br>car setup: test<br>track: test</h2>
      <h2><u>FRONT:</u></h2>Brake bias: <u>&#999999999999;</u><br><br>`;

    const result = inspectFileBytes({ data: Buffer.from(html), filename: "invalid-entity.html" });

    expect(result.parser).toBe("iracing-garage-html");
    expect(result.extractedText).toContain("Brake bias: &#999999999999;");
  });
});

function storedZip(name: string, contents: Buffer): Buffer {
  const filename = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(filename.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE(0, 42);

  const localRecord = Buffer.concat([local, filename, contents]);
  const centralRecord = Buffer.concat([central, filename]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRecord.length, 12);
  eocd.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, centralRecord, eocd]);
}
