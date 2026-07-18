import { queryGeneratedCsv, queryGeneratedTable, readGeneratedFile } from "../../tools/generatedFileTools.js";
import { cleanAgentResponse, stringArgument, stringArrayArgument, numberArgument, booleanArgument } from "./arguments.js";
import type { ToolName } from "../../tools/registry.js";
import type { LocalToolHandler } from "./types.js";

// Uniform signatures intentionally expose only the inputs each tool needs.
/* eslint-disable @typescript-eslint/no-unused-vars */
export const generatedDataToolHandlers = {
  "readGeneratedFile": async (ctx, route, originalText) => {
    return cleanAgentResponse(
          await readGeneratedFile(ctx, {
            fileName: stringArgument(route.arguments, "fileName"),
            fileIndex: numberArgument(route.arguments, "fileIndex"),
            offsetBytes: numberArgument(route.arguments, "offsetBytes"),
            maxBytes: numberArgument(route.arguments, "maxBytes"),
          }),
          ctx.config.maxReplyChars,
        );
  },
  "queryGeneratedCsv": async (ctx, route, originalText) => {
    return cleanAgentResponse(
          await queryGeneratedCsv(ctx, {
            fileName: stringArgument(route.arguments, "fileName"),
            fileIndex: numberArgument(route.arguments, "fileIndex"),
            operation: stringArgument(route.arguments, "operation"),
            column: stringArgument(route.arguments, "column"),
            filters: route.arguments?.filters,
            selectColumns: stringArrayArgument(route.arguments, "selectColumns"),
            limit: numberArgument(route.arguments, "limit"),
            splitValues: booleanArgument(route.arguments, "splitValues"),
            valueDelimiter: stringArgument(route.arguments, "valueDelimiter"),
          }),
          ctx.config.maxReplyChars,
        );
  },
  "queryGeneratedTable": async (ctx, route, originalText) => {
    return cleanAgentResponse(
          await queryGeneratedTable(ctx, {
            tableName: stringArgument(route.arguments, "tableName"),
            tableIndex: numberArgument(route.arguments, "tableIndex"),
            operation: stringArgument(route.arguments, "operation"),
            column: stringArgument(route.arguments, "column"),
            filters: route.arguments?.filters,
            selectColumns: stringArrayArgument(route.arguments, "selectColumns"),
            limit: numberArgument(route.arguments, "limit"),
            splitValues: booleanArgument(route.arguments, "splitValues"),
            valueDelimiter: stringArgument(route.arguments, "valueDelimiter"),
          }),
          ctx.config.maxReplyChars,
        );
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;
/* eslint-enable @typescript-eslint/no-unused-vars */
