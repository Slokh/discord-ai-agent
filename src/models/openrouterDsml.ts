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
  return content.replace(/<[^>]*DSML[^>]*tool_calls[^>]*>[\s\S]*?<\/[^>]*DSML[^>]*tool_calls>/g, "");
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
