const MAX_EXTRACTED_CHARS = 20_000;

export function decodeText(data: Buffer, declared?: string | null, response?: string | null) {
  if (data.length === 0) return { value: "", encoding: "utf-8" };
  if (data.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) return { value: data.subarray(2).toString("utf16le"), encoding: "utf-16le" };
  if (data.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) return { value: swapUtf16Bytes(data.subarray(2)).toString("utf16le"), encoding: "utf-16be" };
  const mime = `${declared ?? ""} ${response ?? ""}`.toLowerCase();
  if (oddNullRatio(data) > 0.3 && evenPrintableRatio(data) > 0.6) return { value: data.toString("utf16le"), encoding: "utf-16le" };
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (mime.includes("text/") || mime.includes("json") || mime.includes("xml") || printableRatio(value) > 0.85) return { value, encoding: "utf-8" };
  } catch {
    return null;
  }
  return null;
}

export function normalizeText(value: string, extension: string) {
  const trimmed = value.replace(/\0/g, "").trim();
  if (extension === "json") {
    try {
      return normalizeExtractedText(JSON.stringify(JSON.parse(trimmed), null, 2));
    } catch {
      // Malformed JSON remains useful as readable text.
    }
  }
  return normalizeExtractedText(trimmed);
}

export function normalizeExtractedText(value: string) {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return { text: normalized.slice(0, MAX_EXTRACTED_CHARS), truncated: normalized.length > MAX_EXTRACTED_CHARS };
}

export function extractPrintableStrings(data: Buffer) {
  const ascii = [...data.toString("latin1").matchAll(/[\x20-\x7e]{6,}/g)].map((match) => match[0]);
  return normalizeExtractedText([...new Set([...extractUtf16StringList(data), ...ascii])].join("\n")).text;
}

export function extractUtf16Strings(data: Buffer) {
  return normalizeExtractedText(extractUtf16StringList(data).join("\n")).text;
}

export function detectedTextType(extension: string, declared?: string | null, response?: string | null) {
  if (response && response !== "application/octet-stream") return response.split(";")[0];
  if (declared && declared !== "application/octet-stream") return declared.split(";")[0];
  if (extension === "json") return "application/json";
  if (["xml", "svg"].includes(extension)) return "application/xml";
  if (extension === "csv") return "text/csv";
  return "text/plain";
}

function extractUtf16StringList(data: Buffer): string[] {
  const strings: string[] = [];
  for (let offset = 0; offset + 1 < data.length;) {
    let cursor = offset;
    let value = "";
    while (cursor + 1 < data.length && data[cursor]! >= 32 && data[cursor]! <= 126 && data[cursor + 1] === 0) {
      value += String.fromCharCode(data[cursor]!);
      cursor += 2;
    }
    if (value.length >= 6) {
      strings.push(value);
      offset = cursor;
    } else offset += 1;
  }
  return strings;
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
    if (data[index] === 9 || data[index] === 10 || data[index] === 13 || (data[index]! >= 32 && data[index]! <= 126)) printable += 1;
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
    const left = output[index]!;
    output[index] = output[index + 1]!;
    output[index + 1] = left;
  }
  return output;
}
