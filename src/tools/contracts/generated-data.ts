import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const generatedDataToolContracts = [
  defineTool({
    name: "readGeneratedFile",
    description:
      "Read a bounded text chunk from a file produced by an earlier tool call in the same agent turn. Use this for generated text or CSV files when the user asks to inspect file contents, see examples, or when a small preview is enough. For exact counts, filters, or rankings over CSV files, use queryGeneratedCsv instead of reading the whole file.",
    userVisible: true,
    mutates: false,
    group: "generated-data",
    category: "memory",
    toolClass: "retrieval",
    outputContract: ["generated file metadata", "byte range", "bounded content excerpt", "truncation status"],
    parameters: {
      type: "object",
      properties: {
        fileName: {
          type: "string",
          description: "Name of the generated file to read. If omitted and exactly one generated file exists, that file is used."
        },
        fileIndex: {
          type: "number",
          description: "1-based index of the generated file to read, useful when multiple generated files exist."
        },
        offsetBytes: {
          type: "number",
          description: "Byte offset to start reading from. Defaults to 0."
        },
        maxBytes: {
          type: "number",
          description: "Maximum bytes to return. Defaults to 4000 and is capped at 20000."
        }
      },
      additionalProperties: false
    }
  }),

  defineTool({
    name: "queryGeneratedCsv",
    description:
      "Run deterministic tabular queries over a CSV file produced by an earlier tool call in the same agent turn. Use this for exact row counts, top values, filters, rankings, and sample rows from generated CSVs instead of asking the model to count or parse raw CSV text. This is generic generated-file infrastructure and is not specific to any provider.",
    userVisible: true,
    mutates: false,
    group: "generated-data",
    category: "memory",
    toolClass: "stats",
    outputContract: ["generated CSV metadata", "filters applied", "row count", "ranked rows or values", "sample rows when requested"],
    parameters: {
      type: "object",
      properties: {
        fileName: {
          type: "string",
          description: "Name of the generated CSV file to query. If omitted and exactly one generated CSV exists, that file is used."
        },
        fileIndex: {
          type: "number",
          description: "1-based index of the generated file to query."
        },
        operation: {
          type: "string",
          enum: ["profile", "topValues", "filterRows"],
          description: "Query operation. profile returns row/column metadata, topValues ranks values in one column, and filterRows returns matching rows."
        },
        column: {
          type: "string",
          description: "Column to rank for topValues."
        },
        filters: {
          type: "array",
          description: "Optional column filters applied before the operation. Comparisons are exact/string/numeric as appropriate; YYYY-MM-DD dates compare correctly as strings.",
          items: {
            type: "object",
            properties: {
              column: { type: "string" },
              op: { type: "string", enum: ["eq", "notEq", "contains", "gt", "gte", "lt", "lte"] },
              value: { type: "string" }
            },
            required: ["column", "op", "value"],
            additionalProperties: false
          }
        },
        selectColumns: {
          type: "array",
          items: { type: "string" },
          description: "Columns to include for filterRows. Defaults to the first columns in the CSV."
        },
        limit: {
          type: "number",
          description: "Maximum rows or ranked values to return. Defaults to 10 and is capped at 100."
        },
        splitValues: {
          type: "boolean",
          description: "For topValues, split each cell before counting. Useful for comma-separated columns like artist lists."
        },
        valueDelimiter: {
          type: "string",
          description: "Delimiter used when splitValues is true. Defaults to comma."
        }
      },
      additionalProperties: false
    }
  }),

  defineTool({
    name: "queryGeneratedTable",
    description:
      "Run deterministic tabular queries over a structured table artifact produced by an earlier tool call in the same agent turn. Use this for exact row counts, top values, filters, rankings, and sample rows from generated tables without reading raw attachment text. This is generic generated-artifact infrastructure and is not specific to any provider.",
    userVisible: true,
    mutates: false,
    group: "generated-data",
    category: "memory",
    toolClass: "stats",
    outputContract: ["generated table metadata", "filters applied", "row count", "ranked rows or values", "sample rows when requested"],
    parameters: {
      type: "object",
      properties: {
        tableName: {
          type: "string",
          description: "Name of the generated table to query. If omitted and exactly one generated table exists, that table is used."
        },
        tableIndex: {
          type: "number",
          description: "1-based index of the generated table to query."
        },
        operation: {
          type: "string",
          enum: ["profile", "topValues", "filterRows"],
          description: "Query operation. profile returns row/column metadata, topValues ranks values in one column, and filterRows returns matching rows."
        },
        column: {
          type: "string",
          description: "Column to rank for topValues."
        },
        filters: {
          type: "array",
          description: "Optional column filters applied before the operation. Comparisons are exact/string/numeric as appropriate; YYYY-MM-DD dates compare correctly as strings.",
          items: {
            type: "object",
            properties: {
              column: { type: "string" },
              op: { type: "string", enum: ["eq", "notEq", "contains", "gt", "gte", "lt", "lte"] },
              value: { type: "string" }
            },
            required: ["column", "op", "value"],
            additionalProperties: false
          }
        },
        selectColumns: {
          type: "array",
          items: { type: "string" },
          description: "Columns to include for filterRows. Defaults to the first columns in the table."
        },
        limit: {
          type: "number",
          description: "Maximum rows or ranked values to return. Defaults to 10 and is capped at 100."
        },
        splitValues: {
          type: "boolean",
          description: "For topValues, split each cell before counting. Useful for comma-separated columns like artist lists."
        },
        valueDelimiter: {
          type: "string",
          description: "Delimiter used when splitValues is true. Defaults to comma."
        }
      },
      additionalProperties: false
    }
  }),
] satisfies ToolRegistryEntry[];
