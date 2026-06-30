const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "github_token", pattern: /\b(?:ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g },
  { name: "openrouter_key", pattern: /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/g },
  { name: "discord_token", pattern: /\bM(?:TA|TI|TM|TQ|TU|TY|Tc|Tg|Tk|jA|jE|jI|jM|jQ|jU|jY|jc|jg|jk)[A-Za-z\d_-]{20,}\.[A-Za-z\d_-]{6,}\.[A-Za-z\d_-]{20,}\b/g },
  { name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/gi },
  { name: "env_secret", pattern: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)[A-Z0-9_]*)=([^\s'"]{8,})/g }
];

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

  return { text, redactionCount, redactionKinds: [...kinds].sort() };
}
