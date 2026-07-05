import { summarizeForAudit, truncateForDiscord } from "../util/text.js";
import type { AgentFile, AgentResponse, AgentTable, ToolContext } from "./types.js";

type CsvFilter = {
  column: string;
  op: "eq" | "notEq" | "contains" | "gt" | "gte" | "lt" | "lte";
  value: string;
};

export type QueryGeneratedCsvInput = {
  fileName?: string;
  fileIndex?: number;
  operation?: string;
  column?: string;
  filters?: unknown;
  selectColumns?: string[];
  limit?: number;
  splitValues?: boolean;
  valueDelimiter?: string;
};

export type QueryGeneratedTableInput = Omit<QueryGeneratedCsvInput, "fileName" | "fileIndex"> & {
  tableName?: string;
  tableIndex?: number;
};

type GeneratedQuerySource = {
  label: "Generated CSV" | "Generated table";
  name: string;
  missingColumnNoun: "CSV" | "table";
};

const DEFAULT_READ_BYTES = 4_000;
const MAX_READ_BYTES = 20_000;
const DEFAULT_CSV_LIMIT = 10;
const MAX_CSV_LIMIT = 100;
const MAX_CSV_BYTES = 10_000_000;
const MAX_CSV_ROWS = 50_000;

export async function readGeneratedFile(
  ctx: ToolContext,
  input: { fileName?: string; fileIndex?: number; offsetBytes?: number; maxBytes?: number } = {}
): Promise<AgentResponse> {
  const resolved = resolveGeneratedFile(ctx, input);
  if (!resolved.file) {
    const content = generatedFileNotFoundMessage(ctx, resolved.reason);
    await audit(ctx, "readGeneratedFile", { ...input, error: resolved.reason });
    return { content };
  }

  const offsetBytes = boundedInteger(input.offsetBytes, 0, resolved.file.data.length, 0);
  const maxBytes = boundedInteger(input.maxBytes, 1, MAX_READ_BYTES, DEFAULT_READ_BYTES);
  const end = Math.min(resolved.file.data.length, offsetBytes + maxBytes);
  const chunk = resolved.file.data.subarray(offsetBytes, end).toString("utf8");
  const content = [
    `Generated file: ${resolved.file.name}`,
    `- Index: ${resolved.index + 1}`,
    `- Content type: ${resolved.file.contentType || "unknown"}`,
    `- Bytes: ${resolved.file.data.length}`,
    `- Range: ${offsetBytes}-${end}${end < resolved.file.data.length ? " (truncated)" : ""}`,
    "",
    truncateForDiscord(chunk, MAX_READ_BYTES)
  ].join("\n");

  await audit(ctx, "readGeneratedFile", {
    fileName: resolved.file.name,
    fileIndex: resolved.index + 1,
    offsetBytes,
    maxBytes,
    returnedBytes: end - offsetBytes
  });
  return { content };
}

export async function queryGeneratedCsv(ctx: ToolContext, input: QueryGeneratedCsvInput = {}): Promise<AgentResponse> {
  const resolved = resolveGeneratedCsvFile(ctx, input);
  if (!resolved.file) {
    const content = generatedFileNotFoundMessage(ctx, resolved.reason);
    await audit(ctx, "queryGeneratedCsv", { ...auditInput(input), error: resolved.reason });
    return { content };
  }

  if (!isCsvFile(resolved.file)) {
    const content =
      `Generated file ${resolved.file.name} is not a CSV file. ` +
      "For exact CSV queries, call the tool that produced it again with a CSV output format when that tool supports one, then call queryGeneratedCsv on the CSV. " +
      "Use readGeneratedFile only for bounded text previews.";
    await audit(ctx, "queryGeneratedCsv", { ...auditInput(input), fileName: resolved.file.name, error: "not_csv" });
    return { content };
  }
  if (resolved.file.data.length > MAX_CSV_BYTES) {
    const content = `Generated CSV ${resolved.file.name} is too large to query in-process (${resolved.file.data.length} bytes; max ${MAX_CSV_BYTES}).`;
    await audit(ctx, "queryGeneratedCsv", { ...auditInput(input), fileName: resolved.file.name, error: "csv_too_large" });
    return { content };
  }

  const parsed = parseCsv(resolved.file.data.toString("utf8"));
  if (parsed.rows.length > MAX_CSV_ROWS) {
    const content = `Generated CSV ${resolved.file.name} has too many rows to query in-process (${parsed.rows.length}; max ${MAX_CSV_ROWS}).`;
    await audit(ctx, "queryGeneratedCsv", { ...auditInput(input), fileName: resolved.file.name, error: "too_many_rows" });
    return { content };
  }
  if (parsed.headers.length === 0) {
    const content = `Generated CSV ${resolved.file.name} did not contain a header row.`;
    await audit(ctx, "queryGeneratedCsv", { ...auditInput(input), fileName: resolved.file.name, error: "missing_header" });
    return { content };
  }

  const operation = csvOperation(input.operation);
  const filters = parseCsvFilters(input.filters, parsed.headers);
  if (filters.error) {
    await audit(ctx, "queryGeneratedCsv", { ...auditInput(input), fileName: resolved.file.name, error: filters.error });
    return { content: filters.error };
  }

  const filteredRows = parsed.rows.filter((row) => filters.filters.every((filter) => rowMatchesFilter(row, filter)));
  const limit = boundedInteger(input.limit, 1, MAX_CSV_LIMIT, DEFAULT_CSV_LIMIT);
  const source: GeneratedQuerySource = { label: "Generated CSV", name: resolved.file.name, missingColumnNoun: "CSV" };
  const content =
    operation === "topValues"
      ? formatTopValuesGeneratedQuery(source, parsed.headers, filteredRows, input, filters.filters, limit)
      : operation === "filterRows"
        ? formatFilteredRowsGeneratedQuery(source, parsed.headers, filteredRows, input.selectColumns, filters.filters, limit)
        : formatGeneratedProfile(source, parsed.headers, parsed.rows.length, filteredRows.length, filters.filters, limit);

  await audit(ctx, "queryGeneratedCsv", {
    ...auditInput(input),
    fileName: resolved.file.name,
    operation,
    rowCount: parsed.rows.length,
    filteredRows: filteredRows.length
  });
  return { content };
}

export async function queryGeneratedTable(ctx: ToolContext, input: QueryGeneratedTableInput = {}): Promise<AgentResponse> {
  const resolved = resolveGeneratedTable(ctx, input);
  if (!resolved.table) {
    const content = generatedTableNotFoundMessage(ctx, resolved.reason);
    await audit(ctx, "queryGeneratedTable", { ...auditInput(input), error: resolved.reason });
    return { content };
  }

  const headers = resolved.table.columns;
  if (headers.length === 0) {
    const content = `Generated table ${resolved.table.name} did not contain any columns.`;
    await audit(ctx, "queryGeneratedTable", { ...auditInput(input), tableName: resolved.table.name, error: "missing_columns" });
    return { content };
  }
  if (resolved.table.rows.length > MAX_CSV_ROWS) {
    const content = `Generated table ${resolved.table.name} has too many rows to query in-process (${resolved.table.rows.length}; max ${MAX_CSV_ROWS}).`;
    await audit(ctx, "queryGeneratedTable", { ...auditInput(input), tableName: resolved.table.name, error: "too_many_rows" });
    return { content };
  }

  const rows = tableRows(resolved.table);
  const operation = csvOperation(input.operation);
  const filters = parseCsvFilters(input.filters, headers);
  if (filters.error) {
    await audit(ctx, "queryGeneratedTable", { ...auditInput(input), tableName: resolved.table.name, error: filters.error });
    return { content: filters.error };
  }

  const filteredRows = rows.filter((row) => filters.filters.every((filter) => rowMatchesFilter(row, filter)));
  const limit = boundedInteger(input.limit, 1, MAX_CSV_LIMIT, DEFAULT_CSV_LIMIT);
  const source: GeneratedQuerySource = { label: "Generated table", name: resolved.table.name, missingColumnNoun: "table" };
  const content =
    operation === "topValues"
      ? formatTopValuesGeneratedQuery(source, headers, filteredRows, input, filters.filters, limit)
      : operation === "filterRows"
        ? formatFilteredRowsGeneratedQuery(source, headers, filteredRows, input.selectColumns, filters.filters, limit)
        : formatGeneratedProfile(source, headers, rows.length, filteredRows.length, filters.filters, limit);

  await audit(ctx, "queryGeneratedTable", {
    ...auditInput(input),
    tableName: resolved.table.name,
    operation,
    rowCount: rows.length,
    filteredRows: filteredRows.length
  });
  return { content };
}

function formatGeneratedProfile(source: GeneratedQuerySource, headers: string[], rowCount: number, filteredRowCount: number, filters: CsvFilter[], limit: number) {
  return [
    `${source.label} profile: ${source.name}`,
    `- Rows: ${rowCount}`,
    `- Columns: ${headers.length}`,
    filters.length ? `- Rows after filters: ${filteredRowCount}` : null,
    `- Headers: ${headers.join(", ")}`,
    `- Sample columns: ${headers.slice(0, limit).join(", ")}`
  ]
    .filter(Boolean)
    .join("\n");
}

function formatTopValuesGeneratedQuery(
  source: GeneratedQuerySource,
  headers: string[],
  rows: TableRow[],
  input: QueryGeneratedCsvInput,
  filters: CsvFilter[],
  limit: number
) {
  const column = resolveColumn(headers, input.column);
  if (!column) {
    return `Choose a ${source.missingColumnNoun} column to rank. Available columns: ${headers.join(", ")}`;
  }

  const counts = new Map<string, number>();
  const delimiter = input.valueDelimiter ?? ",";
  for (const row of rows) {
    const rawValue = row[column] ?? "";
    const values = input.splitValues ? rawValue.split(delimiter) : [rawValue];
    for (const value of values.map((item) => item.trim()).filter(Boolean)) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
  return [
    `${source.label} top values: ${source.name}`,
    `- Column: ${column}${input.splitValues ? ` (split by ${JSON.stringify(delimiter)})` : ""}`,
    filters.length ? `- Filters: ${formatFilters(filters)}` : null,
    `- Rows matched: ${rows.length}`,
    ranked.length ? ranked.map(([value, count], index) => `${index + 1}. ${value} (${count})`).join("\n") : "No values matched."
  ]
    .filter(Boolean)
    .join("\n");
}

function formatFilteredRowsGeneratedQuery(
  source: GeneratedQuerySource,
  headers: string[],
  rows: TableRow[],
  selectColumns: string[] | undefined,
  filters: CsvFilter[],
  limit: number
) {
  const columns = (selectColumns?.map((column) => resolveColumn(headers, column)).filter((column): column is string => Boolean(column)) ?? []).slice(0, 12);
  const visibleColumns = columns.length > 0 ? columns : headers.slice(0, 8);
  return [
    `${source.label} rows: ${source.name}`,
    filters.length ? `- Filters: ${formatFilters(filters)}` : null,
    `- Rows matched: ${rows.length}`,
    formatRowsAsTable(rows.slice(0, limit), visibleColumns)
  ]
    .filter(Boolean)
    .join("\n");
}

type TableRow = Record<string, string>;

function parseCsv(content: string): { headers: string[]; rows: TableRow[] } {
  const records = csvRecords(content);
  const headers = (records.shift() ?? []).map((header) => header.trim());
  const rows = records
    .filter((record) => record.some((cell) => cell.trim().length > 0))
    .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""])));
  return { headers, rows };
}

function csvRecords(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === '"') {
      if (inQuotes && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && content[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function parseCsvFilters(value: unknown, headers: string[]): { filters: CsvFilter[]; error?: string } {
  if (value == null) return { filters: [] };
  if (!Array.isArray(value)) return { filters: [], error: "Filters must be an array." };
  const filters: CsvFilter[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { filters: [], error: "Each filter must be an object." };
    const raw = item as Record<string, unknown>;
    const column = resolveColumn(headers, typeof raw.column === "string" ? raw.column : undefined);
    const op = csvFilterOp(typeof raw.op === "string" ? raw.op : undefined);
    const filterValue = typeof raw.value === "string" || typeof raw.value === "number" || typeof raw.value === "boolean" ? String(raw.value) : undefined;
    if (!column || !op || filterValue == null) {
      return { filters: [], error: `Invalid CSV filter. Use columns from: ${headers.join(", ")}.` };
    }
    filters.push({ column, op, value: filterValue });
  }
  return { filters };
}

function rowMatchesFilter(row: TableRow, filter: CsvFilter): boolean {
  const cell = row[filter.column] ?? "";
  if (filter.op === "contains") return cell.toLowerCase().includes(filter.value.toLowerCase());
  if (filter.op === "eq") return cell === filter.value;
  if (filter.op === "notEq") return cell !== filter.value;
  const comparison = compareCsvValues(cell, filter.value);
  if (filter.op === "gt") return comparison > 0;
  if (filter.op === "gte") return comparison >= 0;
  if (filter.op === "lt") return comparison < 0;
  return comparison <= 0;
}

function compareCsvValues(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return left.localeCompare(right);
}

function tableRows(table: AgentTable): TableRow[] {
  return table.rows.map((row) =>
    Object.fromEntries(table.columns.map((column) => [column, tableCellToString(row[column])]))
  );
}

function tableCellToString(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

function resolveGeneratedFile(ctx: ToolContext, input: { fileName?: string; fileIndex?: number }): { file?: AgentFile; index: number; reason?: string } {
  const files = ctx.generatedFiles ?? [];
  if (files.length === 0) return { index: -1, reason: "no_generated_files" };
  if (input.fileName) {
    const requested = input.fileName.trim().toLowerCase();
    const index = files.findIndex((file) => file.name.toLowerCase() === requested);
    if (index >= 0) return { file: files[index], index };
    return { index: -1, reason: "file_not_found" };
  }
  if (input.fileIndex != null) {
    const index = Math.floor(input.fileIndex) - 1;
    if (index >= 0 && index < files.length) return { file: files[index], index };
    return { index: -1, reason: "file_index_out_of_range" };
  }
  if (files.length === 1) return { file: files[0], index: 0 };
  return { index: -1, reason: "ambiguous_file" };
}

function resolveGeneratedCsvFile(ctx: ToolContext, input: { fileName?: string; fileIndex?: number }): { file?: AgentFile; index: number; reason?: string } {
  if (input.fileName || input.fileIndex != null) return resolveGeneratedFile(ctx, input);

  const files = ctx.generatedFiles ?? [];
  if (files.length === 0) return { index: -1, reason: "no_generated_files" };

  const csvFiles = files.map((file, index) => ({ file, index })).filter(({ file }) => isCsvFile(file));
  if (csvFiles.length === 1) return csvFiles[0];
  if (csvFiles.length === 0 && files.length === 1) return { file: files[0], index: 0 };
  if (csvFiles.length === 0) return { index: -1, reason: "no_csv_files" };
  return { index: -1, reason: "ambiguous_file" };
}

function resolveGeneratedTable(ctx: ToolContext, input: { tableName?: string; tableIndex?: number }): { table?: AgentTable; index: number; reason?: string } {
  const tables = ctx.generatedTables ?? [];
  if (tables.length === 0) return { index: -1, reason: "no_generated_tables" };
  if (input.tableName) {
    const requested = input.tableName.trim().toLowerCase();
    const index = tables.findIndex((table) => table.name.toLowerCase() === requested);
    if (index >= 0) return { table: tables[index], index };
    return { index: -1, reason: "table_not_found" };
  }
  if (input.tableIndex != null) {
    const index = Math.floor(input.tableIndex) - 1;
    if (index >= 0 && index < tables.length) return { table: tables[index], index };
    return { index: -1, reason: "table_index_out_of_range" };
  }
  if (tables.length === 1) return { table: tables[0], index: 0 };
  return { index: -1, reason: "ambiguous_table" };
}

function generatedFileNotFoundMessage(ctx: ToolContext, reason: string | undefined): string {
  const files = ctx.generatedFiles ?? [];
  if (reason === "no_generated_files") return "No generated files are available yet. Call a tool that produces a file first.";
  if (reason === "no_csv_files") {
    const available = files.map((file, index) => `${index + 1}. ${file.name} (${file.contentType || "unknown"}, ${file.data.length} bytes)`).join("\n");
    const availableTables = generatedTableList(ctx);
    return [
      `No generated CSV files are available yet.`,
      available ? `Available generated files:\n${available}` : null,
      availableTables ? `Available generated tables for queryGeneratedTable:\n${availableTables}` : null
    ]
      .filter(Boolean)
      .join("\n");
  }
  const available = files.map((file, index) => `${index + 1}. ${file.name} (${file.contentType || "unknown"}, ${file.data.length} bytes)`).join("\n");
  return [`I could not resolve that generated file (${reason || "unknown"}).`, available ? `Available generated files:\n${available}` : null]
    .filter(Boolean)
    .join("\n");
}

function generatedTableNotFoundMessage(ctx: ToolContext, reason: string | undefined): string {
  const available = generatedTableList(ctx);
  if (reason === "no_generated_tables") return "No generated tables are available yet. Call a tool that produces a structured table first.";
  return [`I could not resolve that generated table (${reason || "unknown"}).`, available ? `Available generated tables:\n${available}` : null]
    .filter(Boolean)
    .join("\n");
}

function generatedTableList(ctx: ToolContext): string {
  return (ctx.generatedTables ?? [])
    .map((table, index) => `${index + 1}. ${table.name} (${table.rows.length} rows, columns: ${table.columns.join(", ")})`)
    .join("\n");
}

function isCsvFile(file: AgentFile): boolean {
  return file.contentType === "text/csv" || /\.csv$/i.test(file.name);
}

function resolveColumn(headers: string[], column: string | undefined): string | undefined {
  if (!column) return undefined;
  const exact = headers.find((header) => header === column);
  if (exact) return exact;
  return headers.find((header) => header.toLowerCase() === column.toLowerCase());
}

function csvOperation(value: string | undefined): "profile" | "topValues" | "filterRows" {
  return value === "topValues" || value === "filterRows" ? value : "profile";
}

function csvFilterOp(value: string | undefined): CsvFilter["op"] | undefined {
  if (value === "eq" || value === "notEq" || value === "contains" || value === "gt" || value === "gte" || value === "lt" || value === "lte") return value;
  return undefined;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function formatFilters(filters: CsvFilter[]): string {
  return filters.map((filter) => `${filter.column} ${filter.op} ${JSON.stringify(filter.value)}`).join("; ");
}

function formatRowsAsTable(rows: TableRow[], columns: string[]): string {
  if (rows.length === 0) return "No rows matched.";
  const lines = [columns.join(" | "), columns.map(() => "---").join(" | ")];
  for (const row of rows) {
    lines.push(columns.map((column) => (row[column] ?? "").replace(/\s+/g, " ").slice(0, 120)).join(" | "));
  }
  return lines.join("\n");
}

function auditInput(input: QueryGeneratedCsvInput | QueryGeneratedTableInput): Record<string, unknown> {
  return {
    fileName: "fileName" in input ? input.fileName : undefined,
    fileIndex: "fileIndex" in input ? input.fileIndex : undefined,
    tableName: "tableName" in input ? input.tableName : undefined,
    tableIndex: "tableIndex" in input ? input.tableIndex : undefined,
    operation: input.operation,
    column: input.column,
    limit: input.limit,
    splitValues: input.splitValues,
    filterCount: Array.isArray(input.filters) ? input.filters.length : undefined
  };
}

async function audit(ctx: ToolContext, toolName: string, summary: Record<string, unknown>): Promise<void> {
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName,
    argumentsSummary: summarizeForAudit(summary),
    resultSummary: summarizeForAudit(summary)
  });
}
