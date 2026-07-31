import { runObservedModelCall } from "../agent/modelCallTelemetry.js";
import { UTILITY_REASONING } from "../agent/modelPolicy.js";
import type { ChatContentPart, ImageResult } from "../models/openrouter.js";
import type { ToolContext } from "./types.js";

const MAX_REQUIRED_TEXT_ITEMS = 8;
const MAX_REQUIRED_TEXT_CHARS = 160;
const MAX_VALIDATION_IMAGES = 2;

export type GeneratedImageTextValidationResult = {
  matches: boolean;
  observedText: string[];
};

export function normalizeRequiredImageText(values: string[] | undefined) {
  return [...new Set(
    (values ?? [])
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => value.slice(0, MAX_REQUIRED_TEXT_CHARS)),
  )].slice(0, MAX_REQUIRED_TEXT_ITEMS);
}

export function inferRequiredImageText(sources: string[]) {
  const inferred: string[] = [];
  const patterns = [
    /\b(?:exact|verbatim)\s+(?:title|headline|caption|label|text|wording)\s*(?:is|reads?|says?)?\s*[:=-]?\s*(?:"([^"]+)"|“([^”]+)”|'([^']+)'|([^,.;!?\n]{1,160}))/gi,
    /\b(?:titled|captioned|labeled|labelled)\s+(?:exactly\s+)?(?:"([^"]+)"|“([^”]+)”|'([^']+)'|([^,.;!?\n]{1,160}))/gi,
    /\b(?:title|headline|caption|label|text)\s+(?:is|reads?|says?)\s*[:=-]?\s*(?:"([^"]+)"|“([^”]+)”|'([^']+)'|([^,.;!?\n]{1,160}))/gi,
  ];
  for (const source of sources) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        const value = match.slice(1).find((candidate) => candidate != null)
          ?.trim()
          .replace(/\s+/g, " ")
          .replace(/\s+(?:in|on|for|with|using)\s+the\s+(?:next|new|revised|updated)\b.*$/i, "")
          .trim();
        if (value) inferred.push(value);
      }
    }
  }
  return normalizeRequiredImageText(inferred);
}

export function imageTextCorrectionPrompt(prompt: string, requiredText: string[]) {
  return [
    prompt,
    "",
    "Typography correction: render every required string below exactly as written.",
    "Do not add, remove, misspell, reorder, or substitute any character in these strings:",
    ...requiredText.map((text) => `- ${JSON.stringify(text)}`),
    "Before finishing, visually verify the spelling character by character.",
  ].join("\n");
}

export async function validateGeneratedImageText(
  ctx: ToolContext,
  input: {
    data: ImageResult["data"];
    requiredText: string[];
    attempt: number;
  },
): Promise<GeneratedImageTextValidationResult> {
  const imageParts = input.data.slice(0, MAX_VALIDATION_IMAGES).flatMap((item): ChatContentPart[] => {
    const url = item.b64_json
      ? `data:${item.media_type ?? item.content_type ?? "image/png"};base64,${item.b64_json}`
      : item.url;
    return url ? [{ type: "image_url", image_url: { url } }] : [];
  });
  if (imageParts.length === 0) return { matches: false, observedText: [] };

  const response = await runObservedModelCall(ctx, {
    purpose: "generated_image_text_validation",
    metadata: {
      attempt: input.attempt,
      requiredTextCount: input.requiredText.length,
      imageCount: imageParts.length,
    },
    chat: {
      model: ctx.config.openRouter.utilityModel,
      reasoningEffort: UTILITY_REASONING,
      messages: [
        {
          role: "system",
          content:
            "Verify typography in generated images. Read the visible text carefully and compare it character-for-character with every required string. " +
            "Return JSON only: {\"matches\":boolean,\"observedText\":string[]}. " +
            "matches is true only when every required string appears exactly, including spelling, punctuation, and digits.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Required exact strings:\n${input.requiredText.map((text) => `- ${JSON.stringify(text)}`).join("\n")}`,
            },
            ...imageParts,
          ],
        },
      ],
      temperature: 0,
      maxTokens: 300,
      retryPolicy: "cheap",
    },
  });

  const parsed = parseValidationResponse(response.content);
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "generateImageTextValidation",
    argumentsSummary: JSON.stringify({
      attempt: input.attempt,
      requiredTextCount: input.requiredText.length,
      imageCount: imageParts.length,
    }),
    resultSummary: JSON.stringify({
      matches: parsed.matches,
      observedTextCount: parsed.observedText.length,
    }),
    model: response.model,
    estimatedCostUsd: response.estimatedCostUsd,
  });
  return parsed;
}

function parseValidationResponse(content: string): GeneratedImageTextValidationResult {
  try {
    const json = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as {
      matches?: unknown;
      observedText?: unknown;
    };
    const observedText = Array.isArray(json.observedText)
      ? json.observedText
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.slice(0, MAX_REQUIRED_TEXT_CHARS))
        .slice(0, MAX_REQUIRED_TEXT_ITEMS)
      : [];
    return { matches: json.matches === true, observedText };
  } catch {
    return { matches: false, observedText: [] };
  }
}
