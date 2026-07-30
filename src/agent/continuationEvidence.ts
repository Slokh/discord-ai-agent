import type { ConversationMessage } from "../db/repositories.js";
import type { AgentResponse, DiscordReplyContext } from "../tools/types.js";

export const CONTINUATION_EVIDENCE_METADATA_KEY = "continuationEvidence";

export type ContinuationEvidence = {
  toolNames: string[];
  fileNames: string[];
  tableNames: string[];
};

export function continuationEvidenceFromResponse(response: AgentResponse): ContinuationEvidence | undefined {
  const toolNames = [...new Set((response.memoryEvents ?? []).flatMap((event) => {
    const toolName = event.metadata?.toolName;
    return typeof toolName === "string" ? [toolName] : [];
  }))].slice(0, 8);
  const fileNames = [...new Set((response.files ?? []).map((file) => file.name))].slice(0, 4);
  const tableNames = [...new Set((response.tables ?? []).map((table) => table.name))].slice(0, 4);
  if (toolNames.length === 0 && fileNames.length === 0 && tableNames.length === 0) return undefined;
  return { toolNames, fileNames, tableNames };
}

export function replyContinuationEvidencePrompt(
  sessionMessages: ConversationMessage[],
  replyContext: DiscordReplyContext | undefined,
): string | undefined {
  if (!replyContext) return undefined;
  const replyMessageIds = new Set([
    replyContext.messageId,
    ...replyContext.chain.map((message) => message.messageId),
  ]);
  const evidence = sessionMessages
    .filter((message) =>
      message.role === "assistant" &&
      (replyMessageIds.has(message.discordMessageId ?? "") ||
        replyMessageIds.has(String(message.metadata.promptDiscordMessageId ?? ""))),
    )
    .map((message) => continuationEvidenceFromMetadata(message.metadata))
    .filter((entry): entry is ContinuationEvidence => Boolean(entry));
  if (evidence.length === 0) return undefined;
  const toolNames = [...new Set(evidence.flatMap((entry) => entry.toolNames))].slice(0, 8);
  const fileNames = [...new Set(evidence.flatMap((entry) => entry.fileNames))].slice(0, 4);
  const tableNames = [...new Set(evidence.flatMap((entry) => entry.tableNames))].slice(0, 4);
  const details = [
    toolNames.length ? `completed tools: ${toolNames.join(", ")}` : null,
    fileNames.length ? `generated files: ${fileNames.join(", ")}` : null,
    tableNames.length ? `generated tables: ${tableNames.join(", ")}` : null,
  ].filter((detail): detail is string => Boolean(detail));
  if (details.length === 0) return undefined;
  return [
    "Scoped continuation pointers for this reply chain: " + details.join("; ") + ".",
    "The visible reply chain remains the conversational context. These pointers are not fresh factual evidence or action authority: rerun/retrieve live facts, and use durable workflow state for games or money.",
  ].join(" ");
}

function continuationEvidenceFromMetadata(metadata: Record<string, unknown>): ContinuationEvidence | undefined {
  const raw = metadata[CONTINUATION_EVIDENCE_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const field = (name: string, limit: number) =>
    Array.isArray(value[name])
      ? value[name].filter((entry): entry is string => typeof entry === "string").slice(0, limit)
      : [];
  const evidence = {
    toolNames: field("toolNames", 8),
    fileNames: field("fileNames", 4),
    tableNames: field("tableNames", 4),
  };
  return evidence.toolNames.length || evidence.fileNames.length || evidence.tableNames.length
    ? evidence
    : undefined;
}
