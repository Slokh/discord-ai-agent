import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export type FileInspection = {
  parser: string;
  detectedType: string;
  summary: string;
  extractedText: string | null;
  metadata: Record<string, string | number | boolean | null>;
  sha256: string;
};

const MAX_EXTRACTED_CHARS = 20_000;
const MAX_ARCHIVE_ENTRIES = 100;
const MAX_ARCHIVE_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 4 * 1024 * 1024;

export function inspectFileBytes(input: {
  data: Buffer;
  filename?: string | null;
  declaredContentType?: string | null;
  responseContentType?: string | null;
}): FileInspection {
  const filename = input.filename?.trim() || "attachment";
  const extension = filenameExtension(filename);
  const sha256 = createHash("sha256").update(input.data).digest("hex");

  if (extension === "sto") return inspectIracingSetup(input.data, filename, sha256);
  if (looksLikeZip(input.data)) return inspectZipFile(input.data, sha256);
  if (looksLikeIracingSetupExport(input.data, extension)) return inspectIracingSetupExport(input.data, sha256);

  const imageType = detectImageType(input.data, extension, input.declaredContentType, input.responseContentType);
  if (imageType) {
    return {
      parser: "image-metadata",
      detectedType: imageType,
      summary: "This is an image. Use inspectDiscordImages with the same Discord message to inspect its visual content.",
      extractedText: null,
      metadata: { bytes: input.data.length },
      sha256
    };
  }

  if (input.data.subarray(0, 5).toString("ascii") === "%PDF-") {
    const version = input.data.subarray(5, 8).toString("ascii");
    return {
      parser: "pdf-metadata",
      detectedType: "application/pdf",
      summary: "PDF container detected. Text extraction is not available in this lightweight parser yet.",
      extractedText: null,
      metadata: { bytes: input.data.length, pdfVersion: version },
      sha256
    };
  }

  const text = decodeText(input.data, input.declaredContentType, input.responseContentType);
  if (text) {
    const normalized = normalizeText(text.value, extension);
    return {
      parser: text.encoding === "utf-8" ? "text" : `text-${text.encoding}`,
      detectedType: detectedTextType(extension, input.declaredContentType, input.responseContentType),
      summary: `Decoded ${text.encoding} text${normalized.truncated ? " (truncated to the inspection limit)" : ""}.`,
      extractedText: normalized.text,
      metadata: { bytes: input.data.length, encoding: text.encoding, truncated: normalized.truncated },
      sha256
    };
  }

  const strings = extractPrintableStrings(input.data);
  return {
    parser: "binary-metadata",
    detectedType: input.responseContentType || input.declaredContentType || "application/octet-stream",
    summary: strings
      ? "Opaque binary file detected. Printable strings were extracted, but no semantic parser matched this format."
      : "Opaque binary file detected. No semantic parser or useful printable text matched this format.",
    extractedText: strings || null,
    metadata: {
      bytes: input.data.length,
      first32Hex: input.data.subarray(0, 32).toString("hex"),
      printableStrings: Boolean(strings)
    },
    sha256
  };
}

function inspectIracingSetup(data: Buffer, filename: string, sha256: string): FileInspection {
  if (data.length < 48) return unsupportedSto(data, sha256, "The file is too small to contain a recognized iRacing setup container.");

  const version = data.readUInt32LE(0);
  const declaredPayloadBytes = data.readUInt32LE(4);
  const opaqueSetupBytes = data.readUInt32LE(8);
  const notesBytes = data.readUInt32LE(12);
  const opaqueMetadataBytes = 32;
  const notesOffset = 16 + opaqueSetupBytes + opaqueMetadataBytes;
  const notesEnd = notesOffset + notesBytes;
  const structurallyValid =
    declaredPayloadBytes === data.length - 16 &&
    opaqueSetupBytes <= data.length - 16 - opaqueMetadataBytes &&
    notesOffset <= data.length &&
    notesEnd <= data.length;
  if (!structurallyValid) {
    return unsupportedSto(data, sha256, "The .sto header did not match the supported iRacing setup container layout.", version);
  }

  const opaquePayload = data.subarray(16, 16 + opaqueSetupBytes);
  const opaqueMetadata = data.subarray(16 + opaqueSetupBytes, notesOffset);
  const rawNotes = data.subarray(notesOffset, notesEnd);
  const notes = rawNotes.toString("utf16le").replace(/\0+$/g, "").trim();
  const structuredNotes = structureIracingSetupNotes(notes || extractUtf16Strings(data));
  const normalized = normalizeExtractedText(structuredNotes.text);
  const filenameDetails = inferIracingSetupFilename(filename);
  const payloadEntropy = byteEntropy(opaquePayload);

  return {
    parser: `iracing-sto-v${version}`,
    detectedType: "application/vnd.iracing.setup",
    summary: normalized.text
      ? "Recognized an iRacing setup and extracted its embedded setup notes. The actual setup-value payload is opaque, so individual garage values are not decoded."
      : "Recognized an iRacing setup, but it contains no readable embedded notes. The actual setup-value payload is opaque.",
    extractedText: normalized.text || null,
    metadata: {
      bytes: data.length,
      containerVersion: version,
      headerDeclaredPayloadBytes: declaredPayloadBytes,
      opaqueSetupBytes,
      opaqueSetupSha256: createHash("sha256").update(opaquePayload).digest("hex"),
      opaqueSetupPayloadEntropy: Number(payloadEntropy.toFixed(3)),
      opaqueSetupPayloadHighEntropy: payloadEntropy >= 7.5,
      opaqueContainerMetadataBytes: opaqueMetadata.length,
      opaqueContainerMetadataSha256: createHash("sha256").update(opaqueMetadata).digest("hex"),
      notesBytes,
      notesSha256: createHash("sha256").update(rawNotes).digest("hex"),
      notesSectionCount: structuredNotes.sections.length,
      notesSections: structuredNotes.sections.join(", ") || null,
      notesTruncated: normalized.truncated,
      trailingBytes: data.length - notesEnd,
      setupPurposeFromFilename: filenameDetails.purpose,
      weatherFromFilename: filenameDetails.weather,
      semanticSetupValuesDecoded: false,
      exactValuesDecoder: "Load the .sto in iRacing Garage, export the setup as HTML, then inspect that HTML export."
    },
    sha256
  };
}

function looksLikeIracingSetupExport(data: Buffer, extension: string): boolean {
  if (extension !== "htm" && extension !== "html") return false;
  const head = data.subarray(0, Math.min(data.length, 2_048)).toString("latin1").toLowerCase();
  return head.includes("iracing.com motorsport simulations car setup") &&
    head.includes("iracing.com simulator");
}

function inspectIracingSetupExport(data: Buffer, sha256: string): FileInspection {
  const html = data.toString("latin1");
  const headerMatch = /<h2\b[^>]*align\s*=\s*["']?center["']?[^>]*>([\s\S]*?)<\/h2>/i.exec(html);
  const headerLines = headerMatch ? htmlLines(headerMatch[1]) : [];
  const setupLine = headerLines.find((line) => /\ssetup:\s/i.test(line)) ?? "";
  const setupMatch = /^(.*?)\s+setup:\s*(.*)$/i.exec(setupLine);
  const trackLine = headerLines.find((line) => /^track:\s*/i.test(line)) ?? "";
  const car = setupMatch?.[1]?.trim() || "unknown";
  const setupName = setupMatch?.[2]?.trim().replace(/^<|>$/g, "") || "unknown";
  const track = trackLine.replace(/^track:\s*/i, "").trim() || "unknown";

  const headingPattern = /<h2\b(?![^>]*align\s*=)[^>]*>([\s\S]*?)<\/h2>/gi;
  const headings = [...html.matchAll(headingPattern)];
  const sections: Array<{ name: string; properties: Array<{ name: string; values: string[] }> }> = [];
  let notes = "";
  for (let index = 0; index < headings.length; index += 1) {
    const match = headings[index];
    const name = htmlText(match[1]).replace(/:$/, "").trim();
    const start = (match.index ?? 0) + match[0].length;
    const end = headings[index + 1]?.index ?? html.length;
    const body = html.slice(start, end);
    if (/^notes$/i.test(name)) {
      notes = htmlLines(body).join("\n");
      break;
    }
    if (/^driver aids$/i.test(name)) continue;
    const properties = parseIracingHtmlProperties(body);
    if (properties.length === 0) continue;
    const tireSection = properties.some((property) => /^tread remaining$/i.test(property.name)) &&
      !properties.some((property) => /^(camber|caster|ride height|corner weight|spring)/i.test(property.name));
    sections.push({ name: tireSection && !/tire$/i.test(name) ? `${name} TIRE` : name, properties });
  }

  const propertyCount = sections.reduce((total, section) => total + section.properties.length, 0);
  const decoded = [
    "iRacing Garage setup export (exact simulator-decoded values)",
    `Car: ${car}`,
    `Track: ${track}`,
    `Setup: ${setupName}`,
    "",
    ...sections.flatMap((section) => [
      `[${section.name}]`,
      ...section.properties.map((property) => `${property.name}: ${property.values.join(" | ")}`),
      ""
    ]),
    notes ? "[NOTES]" : "",
    notes
  ].filter(Boolean).join("\n");
  const normalized = normalizeExtractedText(decoded);
  return {
    parser: "iracing-garage-html",
    detectedType: "application/vnd.iracing.setup-export+html",
    summary: `Decoded ${propertyCount} exact garage properties across ${sections.length} setup sections from an iRacing simulator HTML export.`,
    extractedText: normalized.text || null,
    metadata: {
      bytes: data.length,
      car,
      track,
      setupName,
      setupSections: sections.length,
      setupProperties: propertyCount,
      hasSetupNotes: Boolean(notes),
      truncated: normalized.truncated,
      semanticSetupValuesDecoded: true
    },
    sha256
  };
}

function parseIracingHtmlProperties(html: string): Array<{ name: string; values: string[] }> {
  const properties: Array<{ name: string; values: string[] }> = [];
  let current: { name: string; values: string[] } | null = null;
  for (const fragment of html.split(/<br\s*\/?\s*>/i)) {
    const value = htmlText(fragment).trim();
    if (!value) continue;
    const separator = value.indexOf(":");
    if (separator >= 0) {
      current = { name: value.slice(0, separator).trim(), values: [] };
      const firstValue = value.slice(separator + 1).trim();
      if (firstValue) current.values.push(firstValue);
      properties.push(current);
    } else if (current) {
      current.values.push(value);
    }
  }
  return properties.filter((property) => property.name && property.values.length > 0);
}

function htmlLines(html: string): string[] {
  return html
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/h\d>/gi, "\n")
    .split("\n")
    .map((line) => htmlText(line).trim())
    .filter(Boolean);
}

function htmlText(html: string): string {
  return decodeXml(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function structureIracingSetupNotes(notes: string): { text: string; sections: string[] } {
  const lines = notes.replace(/\r\n?/g, "\n").split("\n");
  const sections: string[] = [];
  const output: string[] = [];
  let addedPreambleHeading = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = /^=+\s*(.*?)\s*=+$/.exec(line)?.[1]?.trim();
    if (heading) {
      sections.push(heading);
      output.push("", `[${heading.toUpperCase()}]`);
      continue;
    }
    if (line && sections.length === 0 && !addedPreambleHeading) {
      output.push("[SETUP SELECTION AND USAGE]");
      addedPreambleHeading = true;
    }
    output.push(rawLine.replace(/\s+$/g, ""));
  }
  return { text: output.join("\n").replace(/\n{3,}/g, "\n\n").trim(), sections };
}

function inferIracingSetupFilename(filename: string): { purpose: string | null; weather: string | null } {
  const tokens = filename.replace(/\.sto$/i, "").toLowerCase().split(/[_\s-]+/);
  const purpose = tokens.includes("qualifying") || tokens.at(-1) === "q"
    ? "qualifying (inferred from filename)"
    : tokens.includes("race") || tokens.at(-1) === "r"
      ? "race (inferred from filename)"
      : tokens.includes("endurance")
        ? "endurance (inferred from filename)"
        : tokens.includes("sprint")
          ? "sprint (inferred from filename)"
          : null;
  const weather = tokens.includes("wet") ? "wet (inferred from filename)" : null;
  return { purpose, weather };
}

function byteEntropy(data: Buffer): number {
  if (data.length === 0) return 0;
  const counts = new Array<number>(256).fill(0);
  for (const byte of data) counts[byte] += 1;
  let entropy = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const probability = count / data.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function unsupportedSto(data: Buffer, sha256: string, reason: string, version: number | null = null): FileInspection {
  const strings = extractUtf16Strings(data) || extractPrintableStrings(data);
  return {
    parser: "iracing-sto-fallback",
    detectedType: "application/vnd.iracing.setup",
    summary: `${reason} Treating it as an opaque iRacing setup file.`,
    extractedText: strings || null,
    metadata: { bytes: data.length, containerVersion: version, semanticSetupValuesDecoded: false },
    sha256
  };
}

function inspectZipFile(data: Buffer, sha256: string): FileInspection {
  try {
    const archive = readZip(data);
    const names = archive.entries.map((entry) => entry.name);
    if (names.includes("word/document.xml")) {
      const xml = archive.readText("word/document.xml");
      const extracted = normalizeExtractedText(xmlText(xml, ["w:p", "w:tr"]));
      return officeInspection("office-docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extracted, archive, sha256);
    }
    if (names.some((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))) {
      const slides = archive.entries
        .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
        .map((entry, index) => `Slide ${index + 1}\n${xmlText(archive.readText(entry.name), ["a:p"])}`)
        .join("\n\n");
      return officeInspection("office-pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", normalizeExtractedText(slides), archive, sha256);
    }
    if (names.some((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))) {
      const extracted = normalizeExtractedText(extractSpreadsheetText(archive));
      return officeInspection("office-xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extracted, archive, sha256);
    }

    const listing = archive.entries
      .slice(0, MAX_ARCHIVE_ENTRIES)
      .map((entry) => `${entry.name} (${entry.uncompressedBytes} bytes)`)
      .join("\n");
    const extracted = normalizeExtractedText(listing);
    return {
      parser: "zip-directory",
      detectedType: "application/zip",
      summary: `ZIP archive detected with ${archive.entries.length} entr${archive.entries.length === 1 ? "y" : "ies"}. Contents were listed without writing or executing files.`,
      extractedText: extracted.text || null,
      metadata: { bytes: data.length, entries: archive.entries.length, listingTruncated: archive.entries.length > MAX_ARCHIVE_ENTRIES },
      sha256
    };
  } catch (error) {
    return {
      parser: "zip-metadata",
      detectedType: "application/zip",
      summary: `ZIP container detected but safe inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      extractedText: null,
      metadata: { bytes: data.length },
      sha256
    };
  }
}

function officeInspection(
  parser: string,
  detectedType: string,
  extracted: { text: string; truncated: boolean },
  archive: ZipArchive,
  sha256: string
): FileInspection {
  return {
    parser,
    detectedType,
    summary: `Extracted text from an Office Open XML document${extracted.truncated ? " (truncated to the inspection limit)" : ""}.`,
    extractedText: extracted.text || null,
    metadata: { entries: archive.entries.length, truncated: extracted.truncated },
    sha256
  };
}

type ZipEntry = {
  name: string;
  flags: number;
  method: number;
  compressedBytes: number;
  uncompressedBytes: number;
  localHeaderOffset: number;
};

type ZipArchive = {
  entries: ZipEntry[];
  readText(name: string): string;
};

function readZip(data: Buffer): ZipArchive {
  const eocd = findEndOfCentralDirectory(data);
  if (eocd < 0) throw new Error("end-of-central-directory record not found");
  const entryCount = data.readUInt16LE(eocd + 10);
  const centralOffset = data.readUInt32LE(eocd + 16);
  if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error(`archive has too many entries (${entryCount}; max ${MAX_ARCHIVE_ENTRIES})`);

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > data.length || data.readUInt32LE(cursor) !== 0x02014b50) throw new Error("invalid central-directory entry");
    const flags = data.readUInt16LE(cursor + 8);
    const method = data.readUInt16LE(cursor + 10);
    const compressedBytes = data.readUInt32LE(cursor + 20);
    const uncompressedBytes = data.readUInt32LE(cursor + 24);
    const filenameBytes = data.readUInt16LE(cursor + 28);
    const extraBytes = data.readUInt16LE(cursor + 30);
    const commentBytes = data.readUInt16LE(cursor + 32);
    const localHeaderOffset = data.readUInt32LE(cursor + 42);
    const name = data.subarray(cursor + 46, cursor + 46 + filenameBytes).toString("utf8");
    if (!name || name.includes("\0") || name.split(/[\\/]/).includes("..")) throw new Error("unsafe archive entry name");
    entries.push({ name, flags, method, compressedBytes, uncompressedBytes, localHeaderOffset });
    cursor += 46 + filenameBytes + extraBytes + commentBytes;
  }

  let expandedBytes = 0;
  return {
    entries,
    readText(name) {
      const entry = entries.find((candidate) => candidate.name === name);
      if (!entry) return "";
      if ((entry.flags & 0x1) !== 0) throw new Error("encrypted ZIP entries are not supported");
      if (entry.uncompressedBytes > MAX_ARCHIVE_ENTRY_BYTES) throw new Error(`archive entry ${name} exceeds the extraction limit`);
      expandedBytes += entry.uncompressedBytes;
      if (expandedBytes > MAX_ARCHIVE_TOTAL_BYTES) throw new Error("archive exceeds the total extraction limit");
      const offset = entry.localHeaderOffset;
      if (offset + 30 > data.length || data.readUInt32LE(offset) !== 0x04034b50) throw new Error("invalid local ZIP header");
      const filenameBytes = data.readUInt16LE(offset + 26);
      const extraBytes = data.readUInt16LE(offset + 28);
      const start = offset + 30 + filenameBytes + extraBytes;
      const compressed = data.subarray(start, start + entry.compressedBytes);
      const output = entry.method === 0
        ? compressed
        : entry.method === 8
          ? inflateRawSync(compressed, { maxOutputLength: MAX_ARCHIVE_ENTRY_BYTES })
          : null;
      if (!output) throw new Error(`unsupported ZIP compression method ${entry.method}`);
      if (output.length > MAX_ARCHIVE_ENTRY_BYTES || output.length !== entry.uncompressedBytes) throw new Error("archive entry size validation failed");
      return output.toString("utf8");
    }
  };
}

function findEndOfCentralDirectory(data: Buffer): number {
  const floor = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= floor; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function extractSpreadsheetText(archive: ZipArchive): string {
  const sharedXml = archive.entries.some((entry) => entry.name === "xl/sharedStrings.xml")
    ? archive.readText("xl/sharedStrings.xml")
    : "";
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) => xmlText(match[1], []));
  return archive.entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
    .map((entry, index) => {
      const xml = archive.readText(entry.name);
      const cells = [...xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)].map((match) => {
        const attributes = match[1];
        const body = match[2];
        const reference = /\br="([^"]+)"/i.exec(attributes)?.[1] ?? "?";
        const type = /\bt="([^"]+)"/i.exec(attributes)?.[1] ?? "";
        const raw = /<v>([\s\S]*?)<\/v>/i.exec(body)?.[1] ?? xmlText(body, []);
        const value = type === "s" ? shared[Number(raw)] ?? raw : decodeXml(raw);
        return `${reference}=${value}`;
      });
      return `Sheet ${index + 1}\n${cells.join("\n")}`;
    })
    .join("\n\n");
}

function xmlText(xml: string, breakTags: string[]): string {
  let value = xml;
  for (const tag of breakTags) value = value.replace(new RegExp(`</${tag}>`, "gi"), "\n");
  return decodeXml(value.replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (match, code) => decodeCharacterReference(match, code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => decodeCharacterReference(match, code, 16))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function decodeCharacterReference(match: string, code: string, radix: number): string {
  const point = Number.parseInt(code, radix);
  if (!Number.isInteger(point) || point < 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return match;
  return String.fromCodePoint(point);
}

function decodeText(data: Buffer, declaredContentType?: string | null, responseContentType?: string | null) {
  if (data.length === 0) return { value: "", encoding: "utf-8" };
  if (data.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) return { value: data.subarray(2).toString("utf16le"), encoding: "utf-16le" };
  if (data.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) return { value: swapUtf16Bytes(data.subarray(2)).toString("utf16le"), encoding: "utf-16be" };

  const mime = `${declaredContentType ?? ""} ${responseContentType ?? ""}`.toLowerCase();
  const utf16Likely = oddNullRatio(data) > 0.3 && evenPrintableRatio(data) > 0.6;
  if (utf16Likely) return { value: data.toString("utf16le"), encoding: "utf-16le" };

  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (mime.includes("text/") || mime.includes("json") || mime.includes("xml") || printableRatio(value) > 0.85) {
      return { value, encoding: "utf-8" };
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeText(value: string, extension: string) {
  const trimmed = value.replace(/\0/g, "").trim();
  if (extension === "json") {
    try {
      return normalizeExtractedText(JSON.stringify(JSON.parse(trimmed), null, 2));
    } catch {
      // Return malformed JSON as readable text.
    }
  }
  return normalizeExtractedText(trimmed);
}

function normalizeExtractedText(value: string) {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return { text: normalized.slice(0, MAX_EXTRACTED_CHARS), truncated: normalized.length > MAX_EXTRACTED_CHARS };
}

function extractPrintableStrings(data: Buffer): string {
  const ascii = [...data.toString("latin1").matchAll(/[\x20-\x7e]{6,}/g)].map((match) => match[0]);
  const utf16 = extractUtf16StringList(data);
  return normalizeExtractedText([...new Set([...utf16, ...ascii])].join("\n")).text;
}

function extractUtf16Strings(data: Buffer): string {
  return normalizeExtractedText(extractUtf16StringList(data).join("\n")).text;
}

function extractUtf16StringList(data: Buffer): string[] {
  const strings: string[] = [];
  for (let offset = 0; offset + 1 < data.length; ) {
    let cursor = offset;
    let value = "";
    while (cursor + 1 < data.length && data[cursor] >= 32 && data[cursor] <= 126 && data[cursor + 1] === 0) {
      value += String.fromCharCode(data[cursor]);
      cursor += 2;
    }
    if (value.length >= 6) {
      strings.push(value);
      offset = cursor;
    } else {
      offset += 1;
    }
  }
  return strings;
}

function detectImageType(data: Buffer, extension: string, declared?: string | null, response?: string | null): string | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const mime = response?.toLowerCase() || declared?.toLowerCase();
  if (mime?.startsWith("image/")) return mime.split(";")[0];
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(extension)) return `image/${extension === "jpg" ? "jpeg" : extension}`;
  return null;
}

function detectedTextType(extension: string, declared?: string | null, response?: string | null) {
  if (response && response !== "application/octet-stream") return response.split(";")[0];
  if (declared && declared !== "application/octet-stream") return declared.split(";")[0];
  if (extension === "json") return "application/json";
  if (["xml", "svg"].includes(extension)) return "application/xml";
  if (extension === "csv") return "text/csv";
  return "text/plain";
}

function filenameExtension(filename: string) {
  const clean = filename.split(/[?#]/, 1)[0];
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : "";
}

function looksLikeZip(data: Buffer) {
  return data.length >= 4 && [0x04034b50, 0x06054b50, 0x08074b50].includes(data.readUInt32LE(0));
}

function oddNullRatio(data: Buffer) {
  let nulls = 0;
  let count = 0;
  for (let index = 1; index < data.length; index += 2) {
    count += 1;
    if (data[index] === 0) nulls += 1;
  }
  return count ? nulls / count : 0;
}

function evenPrintableRatio(data: Buffer) {
  let printable = 0;
  let count = 0;
  for (let index = 0; index < data.length; index += 2) {
    count += 1;
    if (data[index] === 9 || data[index] === 10 || data[index] === 13 || (data[index] >= 32 && data[index] <= 126)) printable += 1;
  }
  return count ? printable / count : 0;
}

function printableRatio(value: string) {
  if (!value) return 1;
  let printable = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n" || character === "\r" || character === "\t" || (code >= 32 && code !== 0x7f)) printable += 1;
  }
  return printable / value.length;
}

function swapUtf16Bytes(data: Buffer) {
  const output = Buffer.from(data);
  for (let index = 0; index + 1 < output.length; index += 2) {
    const left = output[index];
    output[index] = output[index + 1];
    output[index + 1] = left;
  }
  return output;
}
