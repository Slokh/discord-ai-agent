import {
  isOpenRouterHttpError,
  type ImageOptions,
  type ImageResult,
} from "../models/openrouter.js";
import type { ToolContext } from "./types.js";
import { imageRequestRecoveryPrompt } from "./imageGenerationPrompts.js";

export async function recoverRejectedImageRequest(
  openRouter: Pick<ToolContext["openRouter"], "generateImage">,
  error: unknown,
  prompt: string,
  options: ImageOptions,
): Promise<{
  prompt: string;
  image?: ImageResult;
  error: unknown;
} | null> {
  if (!isOpenRouterHttpError(error) || error.status !== 400) return null;
  const recoveryPrompt = imageRequestRecoveryPrompt(prompt);
  try {
    return {
      prompt: recoveryPrompt,
      image: await openRouter.generateImage(recoveryPrompt, options),
      error,
    };
  } catch (fallbackError) {
    return { prompt: recoveryPrompt, error: fallbackError };
  }
}
