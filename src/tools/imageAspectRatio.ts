export type ImageAspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4";

const EXPLICIT_IMAGE_ASPECT_RATIO = /\b(1:1|16:9|9:16|4:3|3:4)\b/;
const PORTRAIT_IMAGE_INTENT = /\b(?:portrait|vertical)\b/i;
const LANDSCAPE_IMAGE_INTENT = /\b(?:landscape|horizontal|widescreen)\b/i;
const SQUARE_IMAGE_INTENT = /\bsquare\b/i;

export function inferredImageAspectRatio(prompt: string): ImageAspectRatio | undefined {
  const explicit = EXPLICIT_IMAGE_ASPECT_RATIO.exec(prompt)?.[1] as ImageAspectRatio | undefined;
  if (explicit) return explicit;
  if (SQUARE_IMAGE_INTENT.test(prompt)) return "1:1";
  if (PORTRAIT_IMAGE_INTENT.test(prompt)) return "3:4";
  if (LANDSCAPE_IMAGE_INTENT.test(prompt)) return "16:9";
  return undefined;
}
