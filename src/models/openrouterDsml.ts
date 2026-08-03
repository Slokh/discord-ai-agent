type ParsedToolCall = { id: string; name: string; argumentsText: string };

/** Compatibility parser for provider responses that encode tool calls as DSML. */
export function parseDsmlToolCalls(content: string): ParsedToolCall[] {
  if (!content.includes("DSML") || !content.includes("invoke name=")) return [];
  const invokePattern = /<[^>]*DSML[^>]*invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*DSML[^>]*invoke>/g;
  const parameterPattern = /<[^>]*DSML[^>]*parameter\s+name="([^"]+)"(?:\s+string="([^"]+)")?[^>]*>([\s\S]*?)<\/[^>]*DSML[^>]*parameter>/g;
  const calls: ParsedToolCall[] = [];
  let invoke: RegExpExecArray | null;
  while ((invoke = invokePattern.exec(content)) != null) {
    const [, name, body] = invoke;
    const args: Record<string, unknown> = {};
    let parameter: RegExpExecArray | null;
    while ((parameter = parameterPattern.exec(body)) != null) {
      const [, parameterName, stringFlag, rawValue] = parameter;
      const value = decodeXmlText(rawValue.trim());
      args[parameterName] = stringFlag === "false" ? parseJsonishValue(value) : value;
    }
    calls.push({ id: `dsml_call_${calls.length + 1}`, name, argumentsText: JSON.stringify(args) });
  }
  return calls;
}

export function stripDsmlToolCalls(content: string) {
  let cursor = 0;
  let result = "";
  while (cursor < content.length) {
    const block = nextToolCallsBlock(content, cursor);
    if (!block) return result + content.slice(cursor);
    result += content.slice(cursor, block.start);
    cursor = block.end;
  }
  return result;
}

function nextToolCallsBlock(content: string, from: number): { start: number; end: number } | null {
  let tagStart = content.indexOf("<", from);
  while (tagStart >= 0) {
    const tagEnd = content.indexOf(">", tagStart + 1);
    if (tagEnd < 0) return null;
    const tag = content.slice(tagStart + 1, tagEnd);
    if (!tag.startsWith("/") && tag.includes("DSML") && tag.includes("tool_calls")) {
      let closingStart = content.indexOf("<", tagEnd + 1);
      while (closingStart >= 0) {
        const closingEnd = content.indexOf(">", closingStart + 1);
        if (closingEnd < 0) return null;
        const closingTag = content.slice(closingStart + 1, closingEnd);
        if (closingTag.startsWith("/") && closingTag.includes("DSML") && closingTag.includes("tool_calls")) {
          return { start: tagStart, end: closingEnd + 1 };
        }
        closingStart = content.indexOf("<", closingEnd + 1);
      }
      return null;
    }
    tagStart = content.indexOf("<", tagEnd + 1);
  }
  return null;
}

function parseJsonishValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function decodeXmlText(value: string) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
