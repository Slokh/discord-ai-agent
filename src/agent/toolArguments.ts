export function parseToolArguments(argumentsText: string): Record<string, unknown> {
  return parseToolArgumentsWithMetadata(argumentsText).value;
}

export function parseToolArgumentsWithMetadata(argumentsText: string): {
  value: Record<string, unknown>;
  repaired: boolean;
} {
  const parsed = parseToolArgumentObject(argumentsText);
  if (parsed) return { value: parsed, repaired: false };
  const repaired = closeTrailingJsonDelimiters(argumentsText);
  const repairedValue = repaired ? parseToolArgumentObject(repaired) : null;
  return repairedValue
    ? { value: repairedValue, repaired: true }
    : { value: {}, repaired: false };
}

/**
 * Some providers double-encode structured top-level fields while still
 * returning a valid outer tool-argument object. Recover only fields whose
 * advertised schema explicitly requires an object or array. Scalar strings
 * and protocol/domain transformations remain untouched.
 */
export function coerceStructuredToolArgumentStrings(
  argumentsValue: Record<string, unknown>,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = isRecord(parameters.properties) ? parameters.properties : {};
  let coerced: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(argumentsValue)) {
    if (typeof value !== "string") continue;
    const expectedType = structuredSchemaType(properties[key]);
    if (!expectedType) continue;
    const parsed = parseJson(value);
    if (!matchesStructuredType(parsed, expectedType)) continue;
    coerced ??= { ...argumentsValue };
    coerced[key] = parsed;
  }
  return coerced ?? argumentsValue;
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

function structuredSchemaType(value: unknown): "array" | "object" | null {
  if (!isRecord(value)) return null;
  if (value.type === "array" || value.type === "object") return value.type;
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const variants = value[keyword];
    if (!Array.isArray(variants)) continue;
    const types = new Set(variants.map(structuredSchemaType).filter(Boolean));
    if (types.size === 1) return [...types][0] ?? null;
  }
  return null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function matchesStructuredType(value: unknown, type: "array" | "object") {
  return type === "array" ? Array.isArray(value) : isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
