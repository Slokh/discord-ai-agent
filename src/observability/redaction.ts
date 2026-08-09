const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "github_token", pattern: /\b(?:ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g },
  { name: "openrouter_key", pattern: /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/g },
  { name: "discord_token", pattern: /\bM(?:TA|TI|TM|TQ|TU|TY|Tc|Tg|Tk|jA|jE|jI|jM|jQ|jU|jY|jc|jg|jk)[A-Za-z\d_-]{20,}\.[A-Za-z\d_-]{6,}\.[A-Za-z\d_-]{20,}\b/g },
  { name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/gi },
  { name: "env_secret", pattern: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)[A-Z0-9_]*)=([^\s'"]{8,})/g }
];
const SECRET_FIELD_PATTERN = /^(?:access_?token|api_?key|auth(?:orization)?|cookie|credential|password|private_?key|secret|signature|token)$/i;
const SIGNED_URL_PARAMETER_PATTERN = /([?&](?:access_?token|api_?key|key|signature|sig|token|x-amz-credential|x-amz-signature|x-goog-signature)=)[^&#\s"']+/gi;

export type RedactionResult = {
  text: string;
  redactionCount: number;
  redactionKinds: string[];
};

export function redactSensitiveText(value: string): RedactionResult {
  let text = value;
  const kinds = new Set<string>();
  let redactionCount = 0;

  for (const { name, pattern } of SECRET_PATTERNS) {
    text = text.replace(pattern, (...args: unknown[]) => {
      redactionCount += 1;
      kinds.add(name);
      if (name === "env_secret") return `${String(args[1])}=[REDACTED]`;
      return "[REDACTED]";
    });
  }

  text = text.replace(SIGNED_URL_PARAMETER_PATTERN, (_match, prefix: string) => {
    redactionCount += 1;
    kinds.add("signed_url_parameter");
    return `${prefix}[REDACTED]`;
  });

  return { text, redactionCount, redactionKinds: [...kinds].sort() };
}

export function redactSensitiveData(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactSensitiveText(value).text;
  if (depth >= 8) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((item) => redactSensitiveData(item, depth + 1));
  if (typeof value !== "object") return String(value);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
    key,
    SECRET_FIELD_PATTERN.test(key.replace(/([a-z])([A-Z])/g, "$1_$2"))
      ? "[REDACTED]"
      : redactSensitiveData(nested, depth + 1),
  ]));
}
