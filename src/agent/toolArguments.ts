export function parseToolArguments(argumentsText: string): Record<string, unknown> {
  const parsed = parseToolArgumentObject(argumentsText);
  if (parsed) return parsed;
  const repaired = closeTrailingJsonDelimiters(argumentsText);
  return repaired ? parseToolArgumentObject(repaired) ?? {} : {};
}

function parseToolArgumentObject(argumentsText: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(argumentsText);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function closeTrailingJsonDelimiters(value: string): string | null {
  const stack: Array<"}" | "]"> = [];
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") stack.push("}");
    else if (character === "[") stack.push("]");
    else if (character === "}" || character === "]") {
      if (stack.pop() !== character) return null;
    }
  }
  if (inString || escaped || stack.length === 0) return null;
  return `${value}${stack.reverse().join("")}`;
}
