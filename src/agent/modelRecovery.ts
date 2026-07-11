import type { Logger } from "pino";
import type { ChatMessage } from "../models/openrouter.js";
import { openRouterServerToolDefinitionsForModel } from "../tools/registry.js";
import type { AgentFile, AgentResponse, ToolContext } from "../tools/types.js";
import { durationMs, logger } from "../util/logger.js";
import {
  cleanFinalModelResponse,
  reserveModelCall,
  type ModelCallBudget,
} from "./routerShared.js";
import { recordAgentEvent } from "./runtimeTranscript.js";
import { runObservedModelCall } from "./modelCallTelemetry.js";

export type LeakedHostedToolCall = {
  type:
    "openrouter:web_search" | "openrouter:web_fetch" | "openrouter:datetime";
  arguments: Record<string, string>;
};

export async function recoverFromLeakedHostedToolMarkup(
  ctx: ToolContext,
  input: {
    round?: number;
    text: string;
    messages: ChatMessage[];
    leakedContent: string;
    files: AgentFile[];
    memoryEvents: NonNullable<AgentResponse["memoryEvents"]>;
    requestLogger: Logger;
    startedAt: number;
    model: string;
    estimatedCostUsd?: number;
    modelCallBudget: ModelCallBudget;
  },
): Promise<AgentResponse> {
  const intendedHostedTools = parseLeakedHostedToolCalls(input.leakedContent);
  const leakedOutputArtifact = await storeMalformedHostedToolOutputArtifact(
    ctx,
    {
      round: input.round,
      model: input.model,
      content: input.leakedContent,
      intendedHostedTools,
    },
  );
  input.requestLogger.warn(
    {
      model: input.model,
      intendedHostedTools,
      leakedOutputArtifactId: leakedOutputArtifact?.artifactId,
    },
    "Model leaked hosted tool markup",
  );
  await recordAgentEvent(ctx, {
    eventName: "agent.hosted_tool_markup_leaked",
    level: "warn",
    summary:
      "Model returned raw hosted tool markup instead of a user-visible answer",
    metadata: {
      model: input.model,
      intendedHostedTools,
      leakedOutputArtifactId: leakedOutputArtifact?.artifactId,
    },
  });
  await recordAgentEvent(ctx, {
    audit: {
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "agentError",
      argumentsSummary: input.text,
      error: "hosted_tool_markup_leaked",
      model: input.model,
      estimatedCostUsd: input.estimatedCostUsd,
    },
  });

  const recovery = await hostedToolMarkupRecoveryResponse(ctx, {
    text: input.text,
    messages: input.messages,
    leakedContent: input.leakedContent,
    intendedHostedTools,
    modelCallBudget: input.modelCallBudget,
  });
  input.requestLogger.info(
    {
      durationMs: durationMs(input.startedAt),
      finalChars: recovery.content.length,
      fileCount: input.files.length,
      memoryEventCount: input.memoryEvents.length,
      recoveryContextMessageCount: input.messages.length,
      recoveryToolResultCount: input.messages.filter(
        (message) => message.role === "tool",
      ).length,
    },
    "Agent request complete after hosted tool markup recovery",
  );
  await recordAgentEvent(ctx, {
    eventName: "agent.request.complete",
    summary: `Recovered from hosted tool markup with ${recovery.content.length} chars`,
    metadata: {
      finalChars: recovery.content.length,
      fileCount: input.files.length,
      memoryEventCount: input.memoryEvents.length,
      recoveryContextMessageCount: input.messages.length,
      recoveryToolResultCount: input.messages.filter(
        (message) => message.role === "tool",
      ).length,
    },
    durationMs: durationMs(input.startedAt),
  });
  return {
    content: cleanFinalModelResponse(recovery.content),
    files: input.files.length > 0 ? input.files : undefined,
    memoryEvents:
      input.memoryEvents.length > 0 ? input.memoryEvents : undefined,
  };
}

export async function hostedToolMarkupRecoveryResponse(
  ctx: ToolContext,
  input: {
    text: string;
    messages?: ChatMessage[];
    leakedContent?: string;
    intendedHostedTools?: LeakedHostedToolCall[];
    modelCallBudget: ModelCallBudget;
  },
) {
  const messages = hostedToolMarkupRecoveryMessages(input.text, input.messages);
  const intendedHostedTools =
    input.intendedHostedTools ??
    parseLeakedHostedToolCalls(input.leakedContent ?? "");
  if (!(await reserveModelCall(ctx, input.modelCallBudget, "hosted_tool_recovery"))) {
    return {
      content: "I hit the model-call safety limit while recovering from a hosted-tool response. Try again in a second.",
      model: undefined,
      estimatedCostUsd: undefined,
    };
  }
  const response = await runObservedModelCall(ctx, {
    purpose: "hosted_tool_markup_recovery",
    chat: {
      messages: [...messages, ...hostedToolRetryMessages(intendedHostedTools)],
      tools: openRouterServerToolDefinitionsForModel(),
      temperature: 0.2,
      maxTokens: 4096,
      retryPolicy: "expensive",
    },
  });
  const content = stripLeakedHostedToolMarkup(response.content).trim();
  return {
    content:
      content ||
      "I tried to look that up, but the hosted web tool returned raw tool-call text instead of a usable result. Try again in a second.",
    model: response.model,
    estimatedCostUsd: response.estimatedCostUsd,
  };
}

async function storeMalformedHostedToolOutputArtifact(
  ctx: ToolContext,
  input: {
    round?: number;
    model: string;
    content: string;
    intendedHostedTools: LeakedHostedToolCall[];
  },
) {
  if (!ctx.requestId) return undefined;
  if (ctx.agentRuntime && ctx.agentRuntimeSession && ctx.agentRuntimeExecutionId) {
    return await ctx.agentRuntime
      .storeArtifact({
        sessionId: ctx.agentRuntimeSession.sessionId,
        executionId: ctx.agentRuntimeExecutionId,
        kind: "model_transcript",
        name: input.round ? `Malformed hosted tool output round ${input.round}` : "Malformed hosted tool output",
        content: input.content,
        contentType: "text/plain",
        metadata: {
          traceId: ctx.requestId,
          model: input.model,
          round: input.round ?? null,
          reason: "hosted_tool_markup_leaked",
          intendedHostedTools: input.intendedHostedTools,
        },
      })
      .catch((error: unknown) => {
        logger.warn(
          { err: error, requestId: ctx.requestId, round: input.round },
          "Failed to store malformed hosted tool output runtime artifact",
        );
        return undefined;
      });
  }
  const storeArtifact = (
    ctx.repo as unknown as {
      storeProcessRunArtifact?: ToolContext["repo"]["storeProcessRunArtifact"];
    }
  ).storeProcessRunArtifact;
  if (!storeArtifact) return undefined;
  return await storeArtifact
    .call(ctx.repo, {
      runId: ctx.requestId,
      kind: "model_transcript",
      name: input.round
        ? `Malformed hosted tool output round ${input.round}`
        : "Malformed hosted tool output",
      content: input.content,
      contentType: "text/plain",
      metadata: {
        model: input.model,
        round: input.round ?? null,
        reason: "hosted_tool_markup_leaked",
        intendedHostedTools: input.intendedHostedTools,
      },
    })
    .catch((error: unknown) => {
      logger.warn(
        { err: error, requestId: ctx.requestId, round: input.round },
        "Failed to store malformed hosted tool output artifact",
      );
      return undefined;
    });
}

function hostedToolRetryMessages(
  intendedHostedTools: LeakedHostedToolCall[],
): ChatMessage[] {
  if (intendedHostedTools.length === 0) return [];
  return [
    {
      role: "system",
      content:
        "The previous assistant response attempted hosted tool request(s) but printed them as plain text instead of using the API tool channel:\n" +
        intendedHostedTools
          .map(
            (tool, index) =>
              `${index + 1}. ${tool.type} ${JSON.stringify(tool.arguments)}`,
          )
          .join("\n") +
        "\nIf this external data is still needed, call the matching hosted tool through the provided tool channel now. Do not print XML-like tool markup.",
    },
  ];
}

function hostedToolMarkupRecoveryMessages(
  text: string,
  messages: ChatMessage[] | undefined,
): ChatMessage[] {
  const contextMessages = messages?.length
    ? sanitizeMessagesForHostedToolMarkupRecovery(messages)
    : [];
  return [
    ...(contextMessages.length
      ? contextMessages
      : [
          {
            role: "user" as const,
            content: text,
          },
        ]),
    {
      role: "user" as const,
      content:
        "Your previous draft emitted raw hosted tool-call markup instead of a user-visible answer. " +
        "Using the conversation, reply context, and fresh local tool results above, answer the user's latest request in plain text. " +
        "You may use hosted web tools if needed, but never print <tool_call> tags, XML-like tool markup, tool names, or arguments.",
    },
  ];
}

function parseLeakedHostedToolCalls(content: string): LeakedHostedToolCall[] {
  const calls: LeakedHostedToolCall[] = [];
  // Models mutate the tool name when leaking markup (observed in prod:
  // "openserver_web_search" instead of "openrouter_web_search"), so match any
  // snake_case name ending in a known hosted tool suffix, not just the exact
  // registered names.
  const callPattern =
    /(?:<tool_call>\s*)?([a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:web_search|web_fetch|datetime))\b([\s\S]*?)(?:<\/tool_call>|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(content)) != null) {
    const toolName = match[1] ?? "";
    const body = match[2] ?? "";
    const type = hostedToolTypeFromMarkupName(toolName);
    if (!type) continue;
    calls.push({
      type,
      arguments: parseLeakedHostedToolArguments(body),
    });
  }
  return calls.slice(0, 5);
}

function hostedToolTypeFromMarkupName(
  name: string,
): LeakedHostedToolCall["type"] | undefined {
  if (name.endsWith("web_search")) return "openrouter:web_search";
  if (name.endsWith("web_fetch")) return "openrouter:web_fetch";
  if (name.endsWith("datetime")) return "openrouter:datetime";
  return undefined;
}

function parseLeakedHostedToolArguments(body: string) {
  const args: Record<string, string> = {};
  const argPattern =
    /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;
  let match: RegExpExecArray | null;
  while ((match = argPattern.exec(body)) != null) {
    const key = decodeXmlText((match[1] ?? "").trim());
    const value = decodeXmlText((match[2] ?? "").trim());
    if (key) args[key] = value;
  }
  return args;
}

function decodeXmlText(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function sanitizeMessagesForHostedToolMarkupRecovery(
  messages: ChatMessage[],
): ChatMessage[] {
  return messages.flatMap((message): ChatMessage[] => {
    if (message.role === "tool") {
      return [
        {
          role: "system",
          content: `Fresh local tool result${message.name ? ` from ${message.name}` : ""}:\n${stringChatContent(message.content)}`,
        },
      ];
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      const toolNames = message.tool_calls
        .map((call) => call.function.name)
        .join(", ");
      const text = stringChatContent(message.content).trim();
      return [
        {
          role: "system",
          content: `The assistant requested local tool call(s): ${toolNames}.${text ? `\nAssistant text: ${text}` : ""}`,
        },
      ];
    }
    return [
      {
        role: message.role,
        content: message.content,
        name: message.name,
      },
    ];
  });
}

function stringChatContent(content: ChatMessage["content"]) {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      return `[image: ${part.image_url.url}]`;
    })
    .join("\n");
}

// Detection and stripping are format-based, not name-based: models mutate tool
// names when leaking markup (prod incident: "<tool_call>openserver_web_search
// </tool_call>"), so any name-list check will eventually miss a variant. Any
// <tool_call> tag or <arg_key>/<arg_value> pair is markup the user must never
// see, regardless of what name appears inside it.
const TOOL_CALL_BLOCK_PATTERN = /<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi;
const STRAY_TOOL_CALL_TAG_PATTERN = /<\/?tool_call>/gi;
const ARG_MARKUP_PATTERN =
  /<arg_key>[\s\S]*?<\/arg_key>\s*(?:<arg_value>[\s\S]*?(?:<\/arg_value>|$))?/gi;
const STRAY_ARG_TAG_PATTERN = /<\/?arg_(?:key|value)>/gi;
const BARE_HOSTED_TOOL_NAME_PATTERN =
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:web_search|web_fetch|datetime)\b[\s\S]*?(?:<\/tool_call>|$)/i;

export function isLeakedHostedToolMarkup(content: string) {
  const trimmed = content.trim();
  return (
    /<tool_call>/i.test(trimmed) ||
    /<\/tool_call>/i.test(trimmed) ||
    /<arg_key>[\s\S]*?<\/arg_key>/i.test(trimmed) ||
    BARE_HOSTED_TOOL_NAME_PATTERN.test(trimmed)
  );
}

export function stripLeakedHostedToolMarkup(content: string) {
  return content
    .replace(TOOL_CALL_BLOCK_PATTERN, "")
    .replace(ARG_MARKUP_PATTERN, "")
    .replace(STRAY_TOOL_CALL_TAG_PATTERN, "")
    .replace(STRAY_ARG_TAG_PATTERN, "")
    .replace(
      new RegExp(BARE_HOSTED_TOOL_NAME_PATTERN.source, "gi"),
      "",
    )
    .trim();
}
