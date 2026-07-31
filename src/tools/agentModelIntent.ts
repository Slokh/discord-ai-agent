import type { ToolContext } from "./types.js";
import { cleanModelArgument, normalizeOpenRouterModelId } from "./agentModelId.js";

export type AgentModelIntent =
  | { action: "set"; target: string; continuationText?: string }
  | { action: "reset"; continuationText?: string };

const CONTINUATION_SEPARATOR = /\s*(?:,|;)\s*(?:and\s+)?then\s+|\s+and\s+then\s+/i;
const CONTEXT_TARGET = /^(?:that|it|that one|the one|the model|the suggested model)$/i;

export function agentModelIntentForPrompt(text: string): AgentModelIntent | null {
  const normalized = stripCommandPreamble(text);
  if (!normalized) return null;

  const { commandText, continuationText } = splitContinuation(normalized);
  const words = commandText.trim().split(/\s+/);
  const verb = words[0] ?? "";
  const rest = commandText.slice(verb.length).trim();

  if (isResetVerb(verb)) {
    if (!isResetModelPhrase(rest)) return null;
    return withContinuation({ action: "reset" }, continuationText);
  }

  if (!isSetVerb(verb)) return null;
  const target = targetAfterSetVerb(verb, rest);
  if (!target) return null;
  if (/^(?:the\s+)?default(?:\s+model)?$/i.test(target)) {
    return withContinuation({ action: "reset" }, continuationText);
  }
  return withContinuation({ action: "set", target }, continuationText);
}

export function hasAgentModelChangeIntent(text: string): boolean {
  return agentModelIntentForPrompt(text) !== null;
}

export function modelTargetFromCurrentContext(
  ctx: ToolContext,
  target: string,
): string | null {
  if (!CONTEXT_TARGET.test(target.trim())) return target;
  const context = [
    ...replyContextContent(ctx),
    ...(ctx.sessionMessages ?? [])
      .filter((message) => message.authorId === ctx.userId || message.role === "assistant")
      .slice(-12)
      .reverse()
      .map((message) => message.content),
  ];
  for (const content of context) {
    const matches = content.match(/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [];
    for (let index = matches.length - 1; index >= 0; index--) {
      const model = normalizeOpenRouterModelId(matches[index]);
      if (model) return model;
    }
  }
  return null;
}

function stripCommandPreamble(value: string): string {
  let text = value.trim()
    .replace(/^<@!?\d+>\s*/i, "")
    .replace(/^(?:hey\s+)?@?ai[\s,:-]*/i, "")
    .trim();
  text = text
    .replace(/^(?:please\s+)+/i, "")
    .replace(/^(?:(?:can|could|would|will)\s+you\s+|i(?:'d|\s+would)?\s+like\s+you\s+to\s+)/i, "")
    .replace(/^(?:let(?:'s|s)\s+|i\s+want\s+(?:you\s+)?to\s+)/i, "")
    .replace(/^(?:please\s+)+/i, "")
    .replace(/^(?:use\s+(?:the\s+)?(?:tool|model tool)\s+to\s+)/i, "")
    .trim();
  return text;
}

function splitContinuation(text: string): { commandText: string; continuationText?: string } {
  const match = CONTINUATION_SEPARATOR.exec(text);
  if (!match || match.index <= 0) return { commandText: text };
  const continuationText = text.slice(match.index + match[0].length).trim();
  return {
    commandText: text.slice(0, match.index).trim(),
    continuationText: continuationText || undefined,
  };
}

function isResetVerb(value: string): boolean {
  return value.toLowerCase() === "reset";
}

function isSetVerb(value: string): boolean {
  const normalized = value.toLowerCase();
  if (["switch", "change", "set", "use"].includes(normalized)) return true;
  return normalized.startsWith("sw") &&
    normalized.length >= 5 &&
    normalized.length <= 8 &&
    editDistance(normalized, "switch") <= 2;
}

function isResetModelPhrase(value: string): boolean {
  return /^(?:(?:the|this)\s+)?(?:(?:agent|ai|bot|chat|server)\s+)?model(?:\s+(?:back\s+)?to\s+(?:the\s+)?default)?\s*[.!]?$/i
    .test(value);
}

function targetAfterSetVerb(verb: string, value: string): string | null {
  let rest = value.trim();
  if (verb.toLowerCase() !== "use") {
    rest = rest
      .replace(/^(?:(?:the|this)\s+)?(?:(?:agent|ai|bot|chat|server)\s+)?model\s+/i, "")
      .replace(/^(?:(?:us|it|this)\s+)?(?:back\s+)?to\s+/i, "");
  } else {
    rest = rest.replace(/^(?:(?:the|this)\s+)?(?:(?:agent|ai|bot|chat|server)\s+)?model\s+/i, "");
  }
  const target = cleanModelArgument(
    rest
      .replace(/\s*[,;]?\s+please\s*[.!?]?\s*$/i, "")
      .replace(/[.!?]\s*$/, ""),
  );
  if (!target || /^(?:models?|tools?)$/i.test(target)) return null;
  return target;
}

function withContinuation<T extends AgentModelIntent>(
  intent: T,
  continuationText: string | undefined,
): T {
  return continuationText ? { ...intent, continuationText } : intent;
}

function replyContextContent(ctx: ToolContext): string[] {
  if (!ctx.replyContext) return [];
  const messages = ctx.replyContext.chain.length > 0
    ? ctx.replyContext.chain
    : [ctx.replyContext];
  return [...messages].reverse().map((message) => message.content);
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    let diagonal = previous[0] ?? 0;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const above = previous[rightIndex] ?? 0;
      previous[rightIndex] = Math.min(
        above + 1,
        (previous[rightIndex - 1] ?? 0) + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}
